import copy
import asyncio
import json
import math
import unittest
from unittest.mock import patch
from tests.backend.test_auth_cors import asgi_request
from pydantic import ValidationError
from shapely.geometry import Point, Polygon, mapping
from backend.planning_network import RoadNetwork, RX
from backend.planning_demand import demand_model
from backend.planning_engine import PlanningStudy
from backend.planning_api import PlanningRequest, router
from backend.auth import require_session
from fastapi import FastAPI


def at(x, y=0):
    return [113.83 + x / RX, 34.03 + y / 111195]


def point(id, x, **p):
    return {'type':'Feature','geometry':{'type':'Point','coordinates':at(x)},'properties':{'id':id,'name':str(id),**p}}


def network(oneway=False):
    nodes=[{'id':i,'coordinates':at(i*1000),'tags':{}} for i in range(4)]
    edges=[]
    roads=[]
    for i in range(3):
        roads.append({'type':'Feature','geometry':{'type':'LineString','coordinates':[at(i*1000),at((i+1)*1000)]},'properties':{'osmId':i,'maxspeed':'40'}})
        for a,b in [(i,i+1)] + ([] if oneway else [(i+1,i)]):
            edges.append({'id':f'{a}-{b}','from':a,'to':b,'osmWayId':i,'lengthM':1000,'highway':'primary','motorVehicleCandidate':True,'motorAccess':'unspecified','directionKnown':True})
    return RoadNetwork({'nodes':nodes,'edges':edges,'turnRestrictions':[]},{'features':roads,'metadata':{'test':True}})


def data():
    polygon=Polygon([at(-200,-500),at(3200,-500),at(3200,500),at(-200,500)])
    return {'boundary':mapping(polygon),'grids':[{'type':'Feature','geometry':mapping(polygon),'properties':{'id':1,'residentialCount':3,'workplaceCount':0,'shoppingCount':0,'leisureCount':0,'publicServiceCount':0}}],
        'stations':[point('old',0),point('virtual',1000,isSynthetic=True)],
        'pois':[point('a',100,category='residential'),point('b',1200,category='residential'),point('c',2400,category='residential')],
        'sites':[point('parking-a',1000,category='parking'),point('parking-b',1100,category='parking'),point('parking-c',2400,category='parking')], 'context':[]}


class RoutingTests(unittest.TestCase):
    def test_direct_same_edge_and_oneway(self):
        road=network(True)
        matrix=road.matrix([at(100),at(700)],[at(700),at(100)])
        self.assertAlmostEqual(matrix['columns'][0][0],54,places=3)
        self.assertIsNone(matrix['columns'][1][1])
        self.assertEqual(matrix['columns'][0][1],0)
        self.assertIs(road.matrix([at(100),at(700)],[at(700),at(100)]),matrix)

    def test_off_network_and_water_connector_do_not_fallback(self):
        road=network()
        self.assertIsNone(road.snap(at(100,201)))
        road.blockers=[Polygon([at(0,20),at(200,20),at(200,40),at(0,40)])]
        self.assertIsNone(road.snap(at(100,100)))
        self.assertIsNone(road.matrix([at(100,201)],[at(0)])['columns'][0][0])

    def test_no_turn_and_disconnected_nodes(self):
        road=network(True)
        road.forbidden[('1','0')].add('1')
        self.assertIsNone(road.matrix([at(500)],[at(1500)])['columns'][0][0])
        # Two geometry crossings with independent OSM IDs must stay disconnected.
        nodes=[{'id':i,'coordinates':c,'tags':{}} for i,c in enumerate([at(0,-500),at(0,500),at(-500),at(500)])]
        edges=[{'id':str(i),'from':a,'to':b,'osmWayId':i,'lengthM':1000,'highway':'primary','motorAccess':'allowed','directionKnown':True,'motorVehicleCandidate':True} for i,(a,b) in enumerate([(0,1),(2,3)])]
        r=RoadNetwork({'nodes':nodes,'edges':edges},{'features':[]})
        self.assertIsNone(r.matrix([at(0,-400)],[at(400)])['columns'][0][0])


class PlanningTests(unittest.TestCase):
    def study(self, **options):
        return PlanningStudy(data(), network(), PlanningRequest(thresholdMinutes=1,**options).model_dump(mode='json'))

    def test_demand_conserved_missing_is_not_zero(self):
        d=data();grids,locations=demand_model(d['grids'],d['pois'])
        self.assertAlmostEqual(sum(p['weight'] for p in locations),sum(g['properties']['scenarioDemandIndex'] for g in grids))
        self.assertFalse(any(p['fallback'] for p in locations))
        d['grids'][0]['properties']={'id':1}
        grids,locations=demand_model(d['grids'],[])
        self.assertIsNone(grids[0]['properties']['scenarioDemandIndex']);self.assertEqual(locations,[])

    def test_default_recorded_uniform_capacity_and_empty_plan(self):
        study=self.study();result=study.analysis()
        self.assertEqual(result['before'],result['after'])
        self.assertEqual(result['before']['stationCount'],1)
        self.assertEqual(result['before']['scenarioPowerKw'],60)
        self.assertEqual(result['capacityBasis'],'uniform-scenario')
        self.assertIsNone(data()['stations'][0]['properties'].get('powerKw'))

    def test_greedy_recomputes_overlap_and_reproducible(self):
        study=self.study(requestedCount=3)
        first=study.optimize();second=study.optimize()
        self.assertEqual(first,second)
        steps=first['selection']['steps']
        self.assertEqual(len(steps),2)
        self.assertNotEqual(steps[0]['candidateId'],steps[1]['candidateId'])
        self.assertEqual(first['selection']['stopReason'],'no-marginal-benefit')
        self.assertFalse(first['selection']['comparableCount'])
        self.assertGreaterEqual(first['after']['coveragePercent'],first['before']['coveragePercent'])
        self.assertLessEqual(first['after']['averageMinutes'],first['before']['averageMinutes'])
        self.assertAlmostEqual(sum(s['coverageGainPoints'] for s in steps),first['changes']['coveragePercent'])
        self.assertTrue(all(s['properties']['feasibility']=='pending' for s in first['selectedStations']['features']))

    def test_exact_threshold_unconnected_denominator_and_frozen_weak_group(self):
        study=self.study()
        study.tau=study.network.matrix([at(100)],[at(0)])['columns'][0][0]
        result=study.analysis()
        p=next(p for p in result['places']['features'] if p['properties']['name']=='a')
        self.assertTrue(p['properties']['beforeCovered'])
        study.tau=math.nextafter(study.tau,-math.inf)
        below=study.analysis()
        p=next(p for p in below['places']['features'] if p['properties']['name']=='a')
        self.assertFalse(p['properties']['beforeCovered'])
        study.locations.append({'feature':{'type':'Feature','geometry':{'type':'Point','coordinates':at(100,300)},'properties':{'name':'offroad'}},'weight':1,'gridId':'1','id':'offroad','fallback':False,'activity':'residential'})
        result=study.analysis()
        self.assertIsNone(result['before']['allDemandAverageMinutes'])
        self.assertIsNotNone(result['before']['averageMinutes'])
        self.assertEqual(result['before']['averageMinutes'],result['before']['reachableAverageMinutes'])
        self.assertGreater(result['before']['unreachableDemandPercent'],0)
        self.assertEqual(result['quality']['unconnectedDemandPoints'],1)
        self.assertGreater(result['quality']['demandWeight'],1)

    def test_nearest_station_compares_ten_and_twenty_minutes_outside_coverage(self):
        study=self.study()
        study.stations=[point('twenty-minute',0),point('ten-minute',1000)]
        matrix={'columns':[[1200,1200,1200],[600,600,600]],'sourceConnected':[True]*3,'targetConnected':[True]*2}
        with patch.object(study.network,'matrix',return_value=matrix):
            result=study.analysis()
            # 一分钟覆盖范围之外，仍然返回十分钟的最近站。
            self.assertEqual(result['before']['coveragePercent'],0)
            self.assertAlmostEqual(result['before']['averageMinutes'],10)
            self.assertTrue(all(p['properties']['beforeNearest']=='ten-minute' for p in result['places']['features']))
            grid=result['grids']['features'][0]['properties']
            self.assertEqual(grid['beforeNearest'],'ten-minute')
            self.assertEqual(grid['beforeNearestMinutes'],10)
            study.tau=30*60
            wider=study.analysis()
            self.assertEqual(wider['before']['coveragePercent'],100)
            self.assertEqual(wider['grids']['features'][0]['properties']['beforeNearestMinutes'],10)

    def test_partial_unreachable_preserves_nearest_station_and_reachable_average(self):
        study=self.study()
        study.tau=10*60
        matrix={'columns':[[600,1200,None]],'sourceConnected':[True,True,False],'targetConnected':[True]}
        with patch.object(study.network,'matrix',return_value=matrix):
            result=study.analysis()
        grid=result['grids']['features'][0]['properties']
        self.assertEqual(grid['beforeNearest'],'old')
        self.assertEqual(grid['beforeNearestMinutes'],10)
        self.assertAlmostEqual(grid['beforeMinutes'],15)
        self.assertAlmostEqual(result['before']['averageMinutes'],15)
        self.assertAlmostEqual(grid['beforeCoverage'],100/3)
        self.assertAlmostEqual(grid['beforeUnreachableDemandPercent'],100/3)
        self.assertEqual(grid['beforeReachablePointCount'],2)
        self.assertEqual(grid['demandPointCount'],3)
        slow=result['places']['features'][1]['properties']
        self.assertEqual(slow['beforeNearest'],'old')
        self.assertEqual(slow['beforeSeconds'],1200)
        self.assertFalse(slow['beforeCovered'])

    def test_no_reachable_station_stays_unknown_without_inventing_time(self):
        study=self.study()
        matrix={'columns':[[None]*3],'sourceConnected':[False]*3,'targetConnected':[True]}
        with patch.object(study.network,'matrix',return_value=matrix):
            result=study.analysis()
        grid=result['grids']['features'][0]['properties']
        self.assertIsNone(grid['beforeNearest'])
        self.assertIsNone(grid['beforeNearestMinutes'])
        self.assertIsNone(grid['beforeMinutes'])
        self.assertEqual(grid['beforeUnreachableDemandPercent'],100)
        self.assertIsNone(result['before']['averageMinutes'])

    def test_site_constraints_and_version_replay(self):
        study=self.study()
        invalid=point('new',500,roadAccess=False)
        with self.assertRaisesRegex(ValueError,'条件'):
            study.analysis([invalid])
        result=study.optimize(count=1)
        replay=PlanningStudy(data(),network(),{**study.options,'baselineKey':result['baselineKey']}).analysis(result['selectedStations']['features'])
        self.assertEqual(result['after'],replay['after'])
        with self.assertRaisesRegex(ValueError,'版本'):
            PlanningStudy(data(),network(),{**study.options,'baselineKey':'old'})
        self.assertEqual(coords_for(result['selectedStations']['features'][0]),coords_for(replay['selectedStations']['features'][0]))
        study.grids[0]['properties']['parkingSpaces']=1
        with self.assertRaisesRegex(ValueError,'合计泊位'):
            study.analysis([point('new-a',1000,pileCount=1,powerKw=60),point('new-b',2400,pileCount=1,powerKw=60)])

    def test_api_auth_validation_experiments_and_no_writes(self):
        app=FastAPI();app.include_router(router)
        class Response:
            def __init__(self, response):
                self.status_code,self.headers,self.body,_=response
                self.text=self.body.decode()
            def json(self): return json.loads(self.body)
        class Client:
            def post(self,path,json): return Response(asyncio.run(asgi_request(app,path,method='POST',body=json)))
        client=Client()
        self.assertEqual(client.post('/api/planning/analyze',json={}).status_code,401)
        app.dependency_overrides[require_session]=lambda: {'username':'test'}
        original=copy.deepcopy(data())
        with patch('backend.planning_api.load_data',return_value=(original,network())):
            self.assertEqual(client.post('/api/planning/analyze',json={'thresholdMinutes':0}).status_code,422)
            self.assertEqual(client.post('/api/planning/analyze',json={'activityWeights':{'wrong':1}}).status_code,422)
            response=client.post('/api/planning/experiments',json={'thresholdMinutes':1,'requestedCount':2})
            self.assertEqual(response.status_code,200,response.text)
            body=response.json();self.assertEqual(len(body['rows']),3)
            self.assertEqual(len({r['versions']['candidates'] for r in body['rows']}),1)
            self.assertEqual(original,data())
            for scenario in ['thresholds','scenarios','weights','counts']:
                response=client.post('/api/planning/experiments',json={'experimentType':scenario,'experimentMode':'fixed' if scenario!='counts' else 'reoptimize','thresholdMinutes':1,'requestedCount':2})
                self.assertEqual(response.status_code,200,response.text)


def coords_for(feature):
    return feature['geometry']['coordinates']


if __name__=='__main__': unittest.main()
