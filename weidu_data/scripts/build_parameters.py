"""Separate external observations from local author-defined scenario parameters."""
import csv,json,math
from pathlib import Path
from pipeline import OUT,save,csv_save,SPEEDS,now

source=next((OUT/'parameters/literature_observed').glob('Fig2a.*'))
rows=[r for r in csv.DictReader(source.open(encoding='utf-8-sig',newline='')) if r.get('') not in (None,'')]
assert len(rows)==97 and [int(r['']) for r in rows]==list(range(97)), 'Unexpected author time grid'
profiles=[]
for day,label in [('workday','weekday'),('weekend & holiday','weekend_holiday')]:
 for row in rows[:96]:
  slot=int(row['']);values={state:float(row[f'Private car_{day}_{state}']) for state in ['driving','charging','parked']}
  assert all(0<=v<=1 for v in values.values()) and abs(sum(values.values())-1)<1e-9
  profiles.append({'day_type':label,'interval_index':slot,'start_time':f'{slot//4:02d}:{slot%4*15:02d}','duration_minutes':15,
   'driving_ratio':values['driving'],'charging_ratio':values['charging'],'parked_ratio':values['parked'],
   'basis':'observed_external_aggregate','geography':'seven_major_Chinese_cities_not_Weidu','observation_period':'2020-11_to_2021-10',
   'vehicle_type':'private_car','charging_scope':'all_charging_public_and_private_not_separated','source_doi':'10.5281/zenodo.13852045',
   'interpretation':'stock_state_share_at_time_not_arrival_rate_or_daily_charging_probability'})
csv_save(OUT/'parameters/time_profiles.csv',profiles)
events_file=next((OUT/'parameters/literature_observed').glob('Fig1f-2.*'))
events=next(r for r in csv.DictReader(events_file.open(encoding='utf-8-sig',newline='')) if r.get('type_2')=='Private car')
save(OUT/'parameters/literature_params.json',{
 'created_at':now(),'observation_geography':'Not Weidu; external evidence only',
 'private_car_daily_charging_events':{'median':float(events['Median (50%)']),'q1':float(events['Q1 (25%)']),'q3':float(events['Q3 (75%)']),'unit':'events_per_vehicle_day','basis':'observed_external_aggregate','source_doi':'10.5281/zenodo.13852045','not_a_probability':True,'charging_scope':'all charging; public/private not separable'},
 'temporal_profiles':{'file':'time_profiles.csv','rows':len(profiles),'interval_minutes':15,'basis':'observed_external_aggregate','source_file':source.name,'end_point_index_96_excluded':'24:00 plotting endpoint; not counted as a 97th daily interval','metadata_caveat':'Archive description mistakenly describes a driving column as parked. Actual column names are retained; all three state shares sum to 1.','weidu_transfer':'Requires local calibration; cannot infer land-use-specific visitor counts.'},
 'public_charging_session_summary_2022':{'mean_session_energy_kwh':25.6,'mean_session_duration_minutes':49.3,'charging_peaks_local_hour_ranges':[[5,7],[12,16],[23,25]],'basis':'industry_observations_secondary_summary','source_url':'https://www.nea.gov.cn/2023-03/20/c_1310703965.htm','population':'Mixed public-platform users; may include commercial vehicles','suitable_as_private_Weidu_default':False},
 'home_or_work_charging_session_share_global':{'approximate_value':0.75,'basis':'international_report_citing_survey','source_url':'https://www.iea.org/reports/global-ev-outlook-2026/electric-vehicle-charging-chap-6-and-10','unit':'share of charging occasions','not_equivalent_to':'Share of Weidu households with home charger, or public-charging-dependent vehicles','suitable_as_private_Weidu_default':False},
 'unavailable_local_parameters':['Weidu private EV fleet','EV ownership by neighbourhood','home charging availability','public charging dependence by household','hourly public session arrivals','parking duration distribution by local functional zone']})

# Explicit illustrative activity weights. They are NOT extracted empirical curves.
def raw_activity(category,hour,day):
 if category=='residential':return 1.0 if hour<7 or hour>=19 else .55 if day=='weekend' else .3
 if category=='work':return (1.0 if 9<=hour<18 else .15) * (.45 if day=='weekend' else 1)
 if category=='commercial':return 1.0 if 10<=hour<21 else .1
 if category=='leisure':return 1.0 if 9<=hour<21 else .2
 return .8 if 8<=hour<18 else .25
activity=[]
for day in ['weekday','weekend']:
 for category in ['residential','work','commercial','leisure','public_service']:
  values=[raw_activity(category,h,day) for h in range(24)];total=sum(values)
  for h,v in enumerate(values):activity.append({'day_type':day,'category':category,'hour':h,'activity_intensity':v,'within_category_daily_normalized_weight':v/total,'basis':'author_scenario_assumption','observation':'none','purpose':'sensitivity_only_not_people_or_charging_events'})
csv_save(OUT/'parameters/time_activity_assumptions.csv',activity)
save(OUT/'parameters/scenario_params.json',{
 'version':'weidu-acquisition-v1','created_at':now(),'status':'scenario_definitions_only_not_calibrated','model_enabled':False,
 'private_vehicle_scope':'ordinary private passenger EVs; exclude taxis, buses, freight and two-wheelers',
 'local_absolute_scaling':{'weidu_private_ev_count':None,'private_cars_per_person':None,'ev_share_of_private_cars':None,'home_charging_available_share':None,'public_charging_dependence_share':None,'daily_public_charge_probability':None,'charging_energy_per_event_kwh':None,'note':'Missing local calibration; do not silently substitute population count, POI count, national shares or commercial-fleet statistics.'},
 'optional_public_dependence_sensitivity':{'values':[.2,.5,.8],'basis':'author_scenario_assumption','default':None,'unit':'share_of_estimated_charging_events','not_a_local_observation':True},
 'time_profile_observed_external':'time_profiles.csv','landuse_activity_scenarios':'time_activity_assumptions.csv',
 'spatial_allocation':{'method':'not_implemented','population_input':'../population/population.tif','population_is_modelled_residential_count':True,'poi_count_is_population':False,'requires_population_preserving_allocation':True,'avoid_double_counting':'Do not separately add the same residential population to every nearby POI; allocate fixed totals before temporal weighting.'},
 'road_accessibility':{'threshold_minutes':10,'speed_kph_by_highway':SPEEDS,'speed_basis':'author_scenario_assumption_not_real_time','sensitivity_factors':[.75,1,1.25],'apply_verified_maxspeed_cap':True,'node_snap_max_m':300,'node_snap_is_verified_entrance':False,'respect_oneway':True,'access_unspecified_policy':'allow_in_optimistic_scenario_only','exclude_private_or_prohibited':True,'turn_restrictions':'retained_not_yet_applied','barriers':'retained_not_yet_validated','network_buffer_km':10,'halo_caveat':'At 80 km/h, 10 minutes spans up to 13.3 km. Extend halo or quantify edge sensitivity before claiming exhaustive accessibility.'},
 'existing_supply':{'observed_locations_file':'../charging/charging_stations.geojson','public_access_unknown_policy':'separate optimistic and documented-public scenarios','unknown_guns_or_power':None,'uniform_capacity_assumptions_must_be_separate':True,'unknown_field_is_zero':False},
 'demand_output_unit':'relative potential index until local calibration; not observed orders, kWh or peak kW'})
print('Parameters: 192 observed external 15-minute private-car profiles; 240 explicitly assumed activity rows; absolute local scaling stays null.')
