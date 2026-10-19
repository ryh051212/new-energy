import { booleanPointInPolygon, distance, point } from '@turf/turf'
import { chargingDistanceWeight, demandLocations, SERVICE_RADIUS_METERS, stationConfiguration } from './facilityDemand.js'
import { validCoordinates } from './stations.js'

export const IMPACT_MODEL = 'fixed-demand-choice-v1'
export const CONSTRUCTION_SURVEY_FIELDS = [
  {key:'sitePermission',label:'用地与场地使用条件'},
  {key:'roadAccess',label:'车辆道路出入口条件'},
  {key:'fireSafety',label:'消防与安全条件'},
]
const idOf=feature=>String(feature.properties?.id)
const finite=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0
const share=(part,total)=>total>0?part/total*100:null
const at=(a,b)=>distance(a,b,{units:'meters'})
const polygons=boundary=>boundary?.type==='FeatureCollection'?boundary.features:boundary?[boundary]:[]

// Only distances are cached. Each scenario reallocates the same demand; no new orders are invented.
function allocate(context,stations) {
  const configurations=[...new Map(stations.map(feature=>[idOf(feature),stationConfiguration(feature)])).values()]
    .filter(item=>!item.blocked&&item.capacity!==0&&validCoordinates(item.feature.geometry?.coordinates))
  const known=configurations.filter(item=>item.capacity!=null)
  const assigned=new Map(configurations.map(item=>[idOf(item.feature),item.capacity==null?null:0]))
  const vectors=new Map(configurations.map(item=>{
    const key=item.feature.geometry.coordinates.join(',')
    if(!context.distances.has(key))context.distances.set(key,context.locations.map(location=>at(location.feature,item.feature)))
    return [item,context.distances.get(key)]
  }))
  const choices=context.locations.map((location,index)=>{
    const ordered=configurations.map(item=>({item,meters:vectors.get(item)[index]})).sort((a,b)=>a.meters-b.meters)
    const reachable=ordered.filter(row=>row.meters<SERVICE_RADIUS_METERS)
    const eligible=reachable.filter(row=>row.item.capacity!=null)
    const attractions=eligible.map(row=>row.item.capacity*chargingDistanceWeight(row.meters))
    const total=attractions.reduce((sum,value)=>sum+value,0)
    const allocations=eligible.map((row,i)=>({id:idOf(row.item.feature),weight:total>0?location.weight*attractions[i]/total:0}))
    for(const row of allocations)assigned.set(row.id,assigned.get(row.id)+row.weight)
    return {allocations,attractionTotal:total,served:total>0,unknownNearby:reachable.some(row=>row.item.capacity==null),
      nearest:ordered[0] || null,options:new Set(reachable.map(row=>row.item.feature.geometry.coordinates.join(','))).size}
  })
  return {configurations,known,assigned,choices}
}

export function createStationImpactContext({features=[],beforeStations=[],demandPois=[]}) {
  const demand=demandLocations(features,demandPois)
  const context={features,beforeStations,locations:demand.locations,fallbackGrids:demand.fallbackGrids,distances:new Map()}
  context.totalDemandWeight=context.locations.reduce((sum,row)=>sum+row.weight,0)
  context.before=allocate(context,beforeStations)
  context.contextKey=JSON.stringify([IMPACT_MODEL,context.locations.map(row=>[row.gridId,row.feature.geometry.coordinates,row.weight]),
    context.before.configurations.map(row=>[idOf(row.feature),row.feature.geometry.coordinates,row.capacity])])
  return context
}

export function evaluateStationPlan({features=[],beforeStations=[],afterStations=[],demandPois=[],scope=null,context:prepared,allocatedAfter}) {
  const context=prepared || createStationImpactContext({features,beforeStations,demandPois})
  const before=context.before,after=allocatedAfter || allocate(context,afterStations),total=context.totalDemandWeight
  const beforeMap=new Map(before.configurations.map(row=>[idOf(row.feature),row])),afterMap=new Map(after.configurations.map(row=>[idOf(row.feature),row]))
  const addedIds=new Set([...afterMap.keys()].filter(id=>!beforeMap.has(id)))
  const changed=[...afterMap.values()].filter(row=>{
    const prior=beforeMap.get(idOf(row.feature))
    return !prior||prior.capacity!==row.capacity||prior.feature.geometry.coordinates.join(',')!==row.feature.geometry.coordinates.join(',')
  }).concat([...beforeMap.values()].filter(row=>!afterMap.has(idOf(row.feature))))
  let newCatchment=0,diverted=0,fromGap=0,uncertainOrigin=0,coveredGain=0,coveredLoss=0,localWeight=0,comparableWeight=0,savedWeighted=0,shortened=0,worsened=0,moreChoices=0,uncertainCoverage=0
  const places=context.locations.map((location,index)=>{
    const a=before.choices[index],b=after.choices[index]
    const newWeight=b.allocations.filter(row=>addedIds.has(row.id)).reduce((sum,row)=>sum+row.weight,0)
    newCatchment+=newWeight
    if(a.served)diverted+=newWeight;else if(a.unknownNearby)uncertainOrigin+=newWeight;else fromGap+=newWeight
    const inScope=!scope || at(location.feature,point(scope.center))<=scope.radiusMeters
    const nearby=inScope&&changed.some(row=>at(location.feature,row.feature)<SERVICE_RADIUS_METERS)
    const newlyReachable=!a.served&&!a.unknownNearby&&b.served,lostReach=a.served&&!b.served&&!b.unknownNearby
    const saved=a.nearest&&b.nearest?a.nearest.meters-b.nearest.meters:null
    if(nearby){
      localWeight+=location.weight
      if(newlyReachable)coveredGain+=location.weight
      if(lostReach)coveredLoss+=location.weight
      if(!a.served&&a.unknownNearby&&b.served)uncertainCoverage+=location.weight
      if(saved!=null){comparableWeight+=location.weight;savedWeighted+=saved*location.weight}
      if(saved>=50)shortened+=location.weight
      if(saved<=-50)worsened+=location.weight
      if(a.options<2&&b.options>=2)moreChoices+=location.weight
    }
    return {...location.feature,properties:{...location.feature.properties,impactModel:IMPACT_MODEL,gridId:location.gridId,
      name:location.feature.properties?.name || (location.fallback?`网格 #${location.gridId} 估计点`:'未命名地点'),fallback:location.fallback,demandWeight:location.weight,
      beforeDistance:a.nearest?.meters ?? null,afterDistance:b.nearest?.meters ?? null,distanceSaved:saved,
      beforeNearest:a.nearest?.item.feature.properties.name || null,afterNearest:b.nearest?.item.feature.properties.name || null,
      newlyReachable,lostReach,nearby,beforeOptions:a.options,afterOptions:b.options}}
  })
  const stationRows=[...new Set([...beforeMap.keys(),...afterMap.keys()])].map(id=>{
    const a=beforeMap.get(id),b=afterMap.get(id),feature=(b || a).feature
    const prior=a?before.assigned.get(id):0,next=b?after.assigned.get(id):0,delta=prior==null||next==null?null:next-prior
    const beforeShare=prior==null?null:share(prior,total),afterShare=next==null?null:share(next,total)
    return {id,name:feature.properties.name || id,added:addedIds.has(id),beforeWeight:prior,afterWeight:next,beforeShare,afterShare,change:delta,
      changeShare:delta==null?null:share(delta,total),relativeChange:prior>0&&next!=null?(next-prior)/prior*100:null,
      feature:{...feature,properties:{...feature.properties,impactModel:IMPACT_MODEL,impactStation:true,beforeDemandShare:beforeShare,afterDemandShare:afterShare}}}
  }).sort((a,b)=>(a.change ?? 0)-(b.change ?? 0))
  const partial=before.configurations.some(row=>row.capacity==null)||after.configurations.some(row=>row.capacity==null)
  const verdict=!total || (!after.known.length&&!before.known.length) ? 'insufficient'
    : coveredLoss>0 || worsened>0 ? 'tradeoff' : coveredGain>0 ? 'gap-filled'
    : shortened>0 ? 'closer' : moreChoices>0 ? 'more-options' : newCatchment>0 ? 'redistribution' : 'no-benefit'
  return {modelVersion:IMPACT_MODEL,contextKey:context.contextKey,verdict,totalDemandWeight:total,localDemandWeight:localWeight,
    newlyReachableWeight:coveredGain,newlyReachableShare:share(coveredGain,localWeight),districtNewlyReachableShare:share(coveredGain,total),districtSavedMeters:before.configurations.length&&total?savedWeighted/total:null,lostReachShare:share(coveredLoss,localWeight),
    distanceBenefitTotal:savedWeighted,averageSavedMeters:comparableWeight?savedWeighted/comparableWeight:null,shortenedShare:share(shortened,localWeight),moreChoicesShare:share(moreChoices,localWeight),
    newCatchmentWeight:newCatchment,divertedWeight:diverted,fromGapWeight:fromGap,uncertainOriginWeight:uncertainOrigin,
    diversionShare:share(diverted,newCatchment),uncertainOriginShare:share(uncertainOrigin,newCatchment),fromGapShare:share(fromGap,newCatchment),uncertainCoverageWeight:uncertainCoverage,
    servedBefore:before.choices.reduce((sum,row,i)=>sum+(row.served?context.locations[i].weight:0),0),servedAfter:after.choices.reduce((sum,row,i)=>sum+(row.served?context.locations[i].weight:0),0),
    stationRows,affectedExistingStations:stationRows.filter(row=>!row.added&&Math.abs(row.change || 0)>1e-9).length,
    places,affectedPlaces:places.filter(row=>row.properties.nearby&&(row.properties.newlyReachable||row.properties.lostReach||row.properties.beforeOptions<2&&row.properties.afterOptions>=2||Math.abs(row.properties.distanceSaved || 0)>=1))
      .sort((a,b)=>Number(b.properties.newlyReachable)-Number(a.properties.newlyReachable)||(b.properties.distanceSaved || 0)-(a.properties.distanceSaved || 0)),
    partialCapacity:partial,unknownBefore:before.configurations.filter(row=>row.capacity==null).length,
    simulatedCapacity:[...before.known,...after.known].some(row=>row.simulated||row.feature.properties.dataSource==='sandbox'),fallbackGrids:context.fallbackGrids,serviceRadiusMeters:SERVICE_RADIUS_METERS}
}

export function evaluateCandidateImpact(context,row,spec) {
  if(!row||!Number.isInteger(spec.pileCount)||spec.pileCount<=0||!finite(spec.powerKw)||spec.powerKw<=0)return null
  const proposal=point(row.location.geometry.coordinates,{...spec,id:'candidate-'+row.id,name:row.areaName+'拟建站',dataSource:'sandbox',isSynthetic:true})
  const item=stationConfiguration(proposal),prior=context.before,id=idOf(proposal)
  const assigned=new Map(prior.configurations.map(entry=>[idOf(entry.feature),entry.capacity==null?null:0]));assigned.set(id,0)
  const colocated=prior.configurations.some(entry=>entry.feature.geometry.coordinates.join(',')===proposal.geometry.coordinates.join(','))
  const choices=context.locations.map((location,index)=>{
    const a=prior.choices[index],meters=at(location.feature,proposal),attraction=item.capacity*chargingDistanceWeight(meters),total=a.attractionTotal+attraction
    const allocations=a.allocations.map(entry=>({id:entry.id,weight:total?entry.weight*a.attractionTotal/total:0}))
    if(attraction>0)allocations.push({id,weight:location.weight*attraction/total})
    for(const entry of allocations)assigned.set(entry.id,assigned.get(entry.id)+entry.weight)
    return {...a,allocations,attractionTotal:total,served:total>0,nearest:!a.nearest||meters<a.nearest.meters?{item,meters}:a.nearest,options:a.options+(meters<SERVICE_RADIUS_METERS&&!colocated?1:0)}
  })
  return evaluateStationPlan({context,afterStations:[],allocatedAfter:{configurations:[...prior.configurations,item],known:[...prior.known,item],assigned,choices}})
}

export function candidateFeasibility(row,spec,{radius=400,minimumSpaces=0,powerFactor=.9,boundary,referenceCount}={}) {
  if(!row)return {status:'pending',checks:[]}
  const checks=[],add=(id,label,state,detail)=>checks.push({id,label,state,detail})
  const validSpec=Number.isInteger(spec.pileCount)&&spec.pileCount>0&&spec.pileCount<=1000&&finite(spec.powerKw)&&spec.powerKw>0&&spec.powerKw<=1000
  const requested=validSpec?spec.pileCount*spec.powerKw:null,survey={...row.feature.properties,...row.extra},borders=polygons(boundary)
  const inside=borders.length?borders.some(border=>booleanPointInPolygon(row.location,border)):null
  add('boundary','研究区位置',inside===null?'pending':inside?'pass':'fail',inside===null?'研究区边界资料未就绪':inside?'在已载入的研究区范围内':'位置超出研究区')
  const validRadius=finite(radius)&&radius<=3000
  add('spacing','与其他站点间距',!validRadius?'fail':row.nearestMeters==null?(referenceCount===0?'pass':'pending'):row.nearestMeters>=radius?'pass':'fail',!validRadius?'间距参数无效':row.nearestMeters==null?'当前数据范围无可用参照站':`${Math.round(row.nearestMeters)} m / 情景阈值 ${radius} m`)
  const spaces=Math.max(spec.pileCount || 1,finite(minimumSpaces)?minimumSpaces:0)
  add('parking','公共可用泊位',row.parkingSpaces==null?'pending':row.parkingSpaces>=spaces?'pass':'fail',row.parkingSpaces==null?'泊位数量待补充':`${row.parkingSpaces} / 本方案至少 ${spaces} 个`)
  add('grid','配变可用余量',!validSpec||!finite(powerFactor)||powerFactor<=0||powerFactor>1?'fail':row.availableKva==null?'pending':row.availableKva*powerFactor>=requested?'pass':'fail',!validSpec?'拟建配置无效':row.availableKva==null?'可用配变容量待补充':`${(row.availableKva*powerFactor).toFixed(1)} kW 可用 / 计划 ${requested} kW`)
  for(const field of CONSTRUCTION_SURVEY_FIELDS){const value=survey[field.key];add(field.key,field.label,value===true?'pass':value===false?'fail':'pending',value===true?'已填情景：满足':value===false?'已填情景：不满足':'资料待核查')}
  return {status:checks.some(row=>row.state==='fail')?'fail':checks.some(row=>row.state==='pending')?'pending':'scenario-pass',checks,evidence:typeof survey.constructionEvidence==='string'?survey.constructionEvidence:''}
}

export function evaluatePlanConstruction({features=[],beforeStations=[],additions=[],removedIds=[],factors={},boundary,options={}}) {
  const retained=beforeStations.filter(feature=>!new Set(removedIds.map(String)).has(idOf(feature)))
  const groups=new Map()
  const rows=additions.map(feature=>{
    const grid=features.find(grid=>booleanPointInPolygon(feature,grid)),gridId=grid?String(grid.properties.id):null
    if(gridId){const group=groups.get(gridId)||{piles:0,kw:0,valid:true};const p=feature.properties;group.valid&&=Number.isInteger(p.pileCount)&&p.pileCount>0&&finite(p.powerKw)&&p.powerKw>0;group.piles+=p.pileCount || 0;group.kw+=(p.pileCount || 0)*(p.powerKw || 0);groups.set(gridId,group)}
    return {feature,grid,gridId}
  })
  const reviews=rows.map(({feature,grid,gridId},index)=>{
    const extra=factors[gridId] || {},p=grid?.properties || {},others=[...retained,...additions.filter((_,i)=>i!==index)].filter(station=>!stationConfiguration(station).blocked&&validCoordinates(station.geometry?.coordinates))
    const nearest=others.length?Math.min(...others.map(station=>at(feature,station))):null
    const group=groups.get(gridId),spec=group?{pileCount:group.piles,powerKw:group.valid?group.kw/group.piles:NaN}:feature.properties
    const row={feature:grid || {properties:{}},location:feature,extra,nearestMeters:nearest,parkingSpaces:extra.parkingSpaces ?? p.parkingSpaces ?? null,availableKva:extra.availableKva ?? p.availableKva ?? null}
    const feasibility=candidateFeasibility(row,spec,{...options,boundary,referenceCount:others.length})
    if(!grid)feasibility.checks.push({id:'grid-location',label:'规划网格归属',state:'fail',detail:'位置没有对应规划网格'})
    if(feasibility.checks.some(check=>check.state==='fail'))feasibility.status='fail'
    return {feature,name:feature.properties.name || idOf(feature),gridId,feasibility,sharedGrid:rows.filter(row=>row.gridId===gridId).length>1}
  })
  return {status:!reviews.length?'no-new-sites':reviews.some(row=>row.feasibility.status==='fail')?'fail':reviews.some(row=>row.feasibility.status==='pending')?'pending':'scenario-pass',rows:reviews,
    blockedCount:reviews.filter(row=>row.feasibility.status==='fail').length,pendingCount:reviews.filter(row=>row.feasibility.status==='pending').length}
}

export function rankPlanningImpacts(rows,reviews,mode='need') {
  return [...rows].sort((a,b)=>{
    const x=reviews.get(a.id),y=reviews.get(b.id)
    const blocked=Number(x?.feasibility.status==='fail')-Number(y?.feasibility.status==='fail')
    if(blocked)return blocked
    if(mode==='need')return (y?.impact?.newlyReachableWeight || 0)-(x?.impact?.newlyReachableWeight || 0)||(y?.impact?.distanceBenefitTotal || 0)-(x?.impact?.distanceBenefitTotal || 0)||(b.score ?? -1)-(a.score ?? -1)
    return (b.score ?? -1)-(a.score ?? -1)
  })
}
