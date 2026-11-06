"""面向本次出行的估算模型；与前端 tripCharging.js 保持同一口径。"""
import math

DEFAULT_TRIP = dict(currentSoc=None, targetSoc=80, batteryKwh=None, consumptionKwh=None,
                    maxChargeKw=None, reserveSoc=10, queueMinutes=None, stayMinutes=60, shoppingMinutes=60,
                    maxWalkMeters=800, travelPricePerKwh=None, powerFactor=.8, efficiency=.9,
                    destination=None, origin=None, chargingRequirement=None)


def valid(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0


def normalize_trip_context(input_context=None):
    raw = input_context or {}
    context = {**DEFAULT_TRIP, **raw, 'stayMinutes': raw.get('stayMinutes', raw.get('shoppingMinutes', 60))}
    for key in DEFAULT_TRIP:
        value = context[key]
        if key == 'chargingRequirement':
            context[key] = value if value in ('DC', 'AC', 'either') else None
            continue
        if key in ('origin', 'destination'):
            context[key] = value if isinstance(value, list) and len(value) == 2 and all(
                isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x) and abs(x) <= bound
                for x, bound in zip(value, (180, 90))) else None
            continue
        try:
            context[key] = float(value) if value is not None and value != '' and not isinstance(value, bool) else None
        except (ValueError, TypeError):
            context[key] = None
        if not valid(context[key]):
            context[key] = None
    for key in ('currentSoc', 'targetSoc', 'reserveSoc'):
        if context[key] is not None and context[key] > 100:
            context[key] = None
    for key in ('batteryKwh', 'consumptionKwh', 'maxChargeKw', 'efficiency', 'powerFactor'):
        if not context[key]:
            context[key] = None
    for key in ('efficiency', 'powerFactor'):
        if context[key] is not None and context[key] > 1:
            context[key] = None
    bounds = dict(batteryKwh=(1, 300), consumptionKwh=(1, 100), maxChargeKw=(1, 1000), queueMinutes=(0, 1440),
                  stayMinutes=(0, 1440), shoppingMinutes=(0, 1440), maxWalkMeters=(0, 10000), travelPricePerKwh=(0, 20), powerFactor=(.01, 1), efficiency=(.01, 1))
    for key, (minimum, maximum) in bounds.items():
        if context[key] is not None and not minimum <= context[key] <= maximum:
            context[key] = None
    context['shoppingMinutes'] = context['stayMinutes']
    return context


def complete_sum(*values):
    return sum(values) if all(valid(value) for value in values) else None


def rounded(value):
    # 与 JavaScript 对非负值的 Math.round 一致。
    return math.floor(value * 100 + .5) / 100 if valid(value) else None


def geo_distance_meters(a, b):
    lat1, lat2 = math.radians(a[1]), math.radians(b[1])
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(math.radians(b[0] - a[0]) / 2) ** 2
    return 12742017.6 * math.asin(math.sqrt(min(1, h)))


def evaluate_trip_station(feature, intent, input_context):
    c, p, missing = normalize_trip_context(input_context), feature.get('properties', {}), []
    destination_intent = intent in ('destination', 'shopping')
    driving = p.get('distanceType') == 'driving' and p.get('distanceSource') == 'amap_driving' and p.get('isFallback') is False and valid(p.get('drivingDistanceMeters'))
    meters = p.get('drivingDistanceMeters') if driving else p.get('straightDistanceMeters', p.get('distanceMeters'))
    vehicle_known = valid(c['currentSoc']) and bool(c['batteryKwh']) and bool(c['consumptionKwh']) and valid(c['reserveSoc'])
    used_energy = meters / 100000 * c['consumptionKwh'] if vehicle_known and valid(meters) else None
    arrival = c['currentSoc'] - used_energy / c['batteryKwh'] * 100 if valid(used_energy) else None
    unreachable = arrival is not None and arrival < c['reserveSoc']
    safety = 'unreachable' if unreachable else 'reachable' if arrival is not None and driving else 'unknown'
    if not vehicle_known:
        missing.append('车辆电量与电耗')
    if not driving:
        missing.append('实际驾车路线')
    energy = max(0, (c['targetSoc'] - arrival) / 100 * c['batteryKwh']) if arrival is not None and valid(c['targetSoc']) else None
    power = min(c['maxChargeKw'], p['powerKw']) * c['powerFactor'] if c['maxChargeKw'] and valid(p.get('powerKw')) and p['powerKw'] > 0 and c['powerFactor'] else None
    charge_minutes = 0 if energy == 0 else energy / c['efficiency'] / power * 60 if valid(energy) and power and c['efficiency'] else None
    if charge_minutes is None:
        missing.append('车辆或站点充电功率')
    queue = p['estimatedWaitMinutes'] if valid(p.get('estimatedWaitMinutes')) else c['queueMinutes']
    if queue is None:
        missing.append('排队时间')
    drive_minutes = p['drivingDurationSeconds'] / 60 if driving and valid(p.get('drivingDurationSeconds')) else None
    if driving and drive_minutes is None:
        missing.append('驾车时间')
    coordinates = feature.get('geometry', {}).get('coordinates')
    walk = geo_distance_meters(coordinates, c['destination']) if c['destination'] and coordinates else None
    walking_minutes = walk / 80 * 2 if valid(walk) else None
    window = c['stayMinutes'] + walking_minutes if all(valid(x) for x in (walking_minutes, queue, c['stayMinutes'])) else None
    shopping_energy = power * window / 60 * c['efficiency'] if valid(window) and power and c['efficiency'] else None
    shopping_charged = min(energy, shopping_energy) if valid(energy) and valid(shopping_energy) else None
    projected = min(100, arrival + shopping_charged / c['batteryKwh'] * 100) if arrival is not None and valid(shopping_charged) else None
    meets_target = shopping_energy >= energy if valid(energy) and valid(shopping_energy) else None
    if destination_intent and not c['destination']:
        missing.append('目的地位置')
    if destination_intent and window is None and queue is not None:
        missing.append('活动时长或步行距离')
    parked = complete_sum(queue, window) if destination_intent else complete_sum(queue, charge_minutes)
    billed_energy = shopping_charged if destination_intent else energy
    grid_energy = billed_energy / c['efficiency'] if valid(billed_energy) and c['efficiency'] else None
    electricity = grid_energy * p['electricityPrice'] if valid(grid_energy) and valid(p.get('electricityPrice')) else None
    service = grid_energy * p['servicePrice'] if valid(grid_energy) and valid(p.get('servicePrice')) else None
    charge_cost = grid_energy * p['pricePerKwh'] if valid(grid_energy) and valid(p.get('pricePerKwh')) else complete_sum(electricity, service)
    parking = 0 if valid(p.get('parkingFee')) and p['parkingFee'] == 0 else parked / 60 * p['parkingFee'] if valid(parked) and valid(p.get('parkingFee')) else None
    route = p.get('tripRoute') or {}
    extra_km = max(0, (p['drivingDistanceMeters'] + route['onwardDistanceMeters'] - route['directDistanceMeters']) / 1000) if driving and all(valid(route.get(x)) for x in ('onwardDistanceMeters', 'directDistanceMeters')) else None
    remaining_km = max(0, extra_km - p['drivingDistanceMeters'] / 1000) if valid(extra_km) else None
    extra_energy_cost = 0 if remaining_km == 0 else remaining_km / 100 * c['consumptionKwh'] * c['travelPricePerKwh'] if valid(remaining_km) and c['consumptionKwh'] and valid(c['travelPricePerKwh']) else None
    tolls = (p.get('drivingTollsYuan'), route.get('onwardTollsYuan'), route.get('directTollsYuan'))
    extra_tolls = max(0, tolls[0] + tolls[1] - tolls[2]) if all(valid(x) for x in tolls) else None
    detour_cost = complete_sum(extra_energy_cost, extra_tolls)
    if intent == 'economy':
        if detour_cost is None:
            missing.append('终点路线或绕行费用')
        if charge_cost is None:
            missing.append('充电费用')
        if parking is None:
            missing.append('停车计费或停留时间')
    total_cost = complete_sum(charge_cost, parking, detour_cost)
    total_minutes = complete_sum(drive_minutes, parked) if destination_intent else complete_sum(drive_minutes, queue, charge_minutes)
    simulated = p.get('simulatedFields') or []
    types = p.get('chargingCurrentTypes')
    types_known = isinstance(types, list) and bool(types) and all(kind in ('DC', 'AC') for kind in types) and not p.get('isSynthetic') and 'chargingCurrentTypes' not in simulated
    mismatched = (p.get('vehicleCompatible') is False and not p.get('isSynthetic') and 'vehicleCompatible' not in simulated) or (types_known and p.get('chargingCurrentTypesComplete') is not False and c['chargingRequirement'] in ('DC', 'AC') and c['chargingRequirement'] not in types)
    operational = p.get('status') not in ('maintenance', 'offline', 'retired') and not mismatched
    too_far = destination_intent and valid(walk) and valid(c['maxWalkMeters']) and walk > c['maxWalkMeters']
    excluded = unreachable or not operational or too_far or (valid(p.get('powerKw')) and p['powerKw'] == 0 and energy is not None and energy > 0)
    return dict(intent=intent, excluded=excluded, safety=safety, arrivalSoc=None if arrival is None else math.floor(arrival * 10 + .5) / 10,
        chargeEnergyKwh=rounded(energy), chargeMinutes=rounded(charge_minutes), driveMinutes=rounded(drive_minutes), queueMinutes=queue,
        queueSource='station' if valid(p.get('estimatedWaitMinutes')) else 'user' if queue is not None else 'unknown',
        totalMinutes=rounded(total_minutes), knownMinutes=rounded(sum(x for x in (drive_minutes, queue, charge_minutes) if valid(x))),
        walkMeters=rounded(walk), walkingMinutes=rounded(walking_minutes), windowMinutes=rounded(window),
        shoppingChargedEnergyKwh=rounded(shopping_charged), projectedSoc=rounded(projected), meetsTarget=meets_target,
        stayChargedEnergyKwh=rounded(shopping_charged), activityMinutes=c['stayMinutes'], parkingMinutes=rounded(parked), walkingSource='straight_estimate',
        electricityCost=rounded(electricity), serviceCost=rounded(service), chargeCost=rounded(charge_cost), parkingCost=rounded(parking),
        extraKm=rounded(extra_km), extraEnergyCost=rounded(extra_energy_cost), extraTolls=rounded(extra_tolls), detourCost=rounded(detour_cost), totalCost=rounded(total_cost),
        knownCost=rounded(sum(x for x in (charge_cost, parking, detour_cost) if valid(x))), missing=list(dict.fromkeys(missing)), isEstimate=True,
        hasDemoInputs=bool(p.get('isSynthetic')) or any(x in (p.get('simulatedFields') or []) for x in ('powerKw', 'electricityPrice', 'servicePrice', 'parkingFee')))


def rank_trip_stations(features, intent, context):
    ranked = [{**f, 'properties': {**f['properties'], 'tripFit': evaluate_trip_station(f, intent, context)}} for f in features]
    ranked = [f for f in ranked if not f['properties']['tripFit']['excluded']]
    def value(x):
        return x if valid(x) else math.inf
    def key(f):
        p, fit = f['properties'], f['properties']['tripFit']
        safety = fit['safety'] != 'reachable'
        distance = value(p.get('distanceMeters'))
        if intent in ('destination', 'shopping'):
            enough = 0 if fit['meetsTarget'] is True else 1 if fit['meetsTarget'] is None else 2
            return safety, enough, value(fit['walkMeters']), value(fit['chargeMinutes']), distance
        if intent == 'economy':
            return safety, fit['totalCost'] is None, value(fit['totalCost']), len(fit['missing']), fit['knownCost'], distance
        return safety, fit['totalMinutes'] is None, value(fit['totalMinutes']), len(fit['missing']), fit['knownMinutes'], distance
    return sorted(ranked, key=key)
