import copy
import unittest
from unittest.mock import patch
from shapely.geometry import Polygon, mapping
from fastapi import HTTPException
from backend.local_siting import local_candidates
from backend.planning_engine import PlanningStudy
from backend.planning_api import PlanningRequest, LocalSitingRequest, confirm_nearby_site
from tests.backend.test_road_planning import data, network, at, point


class LocalSitingTests(unittest.TestCase):
    def study(self, dataset=None, **options):
        return PlanningStudy(dataset or data(), network(), PlanningRequest(**options).model_dump(mode='json'))

    def test_buffer_only_actual_sites_sorted_and_pending(self):
        result=local_candidates(self.study(), at(1050), 200)
        self.assertEqual(len(result['features']),2)
        self.assertTrue(all(f['properties']['distanceMeters']<=200 for f in result['features']))
        self.assertTrue(all(f['properties']['feasibility']=='pending' for f in result['features']))
        self.assertEqual(result['metadata']['considered'],2)
        self.assertEqual(len(local_candidates(self.study(),at(1700),100)['features']),0)

    def test_reject_water_fuel_restricted_land_and_no_road(self):
        for category, extra in [('water',{}),('landuse',{'landuse':'farmland'}),('safety',{'tags':{'amenity':'fuel'}})]:
            d=data()
            d['context']=[{'type':'Feature','geometry':mapping(Polygon([at(900,-100),at(1150,-100),at(1150,100),at(900,100)])),
                           'properties':{'category':category,**extra}}]
            result=local_candidates(self.study(d),at(1050),200)
            self.assertEqual(result['features'],[],category)
            self.assertTrue(result['metadata']['excluded'])
        d=data();d['sites']=[point('far',1000,category='parking')]
        d['sites'][0]['geometry']['coordinates']=at(1000,250)
        self.assertEqual(local_candidates(self.study(d),at(1000),500)['features'],[])

    def test_exclude_entrances_duplicates_and_draft_preserved(self):
        d=data();d['sites'] += [point('entry',1020,category='entrance'),point('entry-catalog',1040,category='parking',typecode='150908'),point('copy',1001,category='parking')]
        before=copy.deepcopy(d)
        result=local_candidates(self.study(d),at(1050),200)
        self.assertEqual(len(result['features']),2)
        feature=result['features'][0]
        self.assertEqual(len(local_candidates(self.study(d,additions=[feature]),at(1050),200)['features']),1)
        self.assertEqual(d,before)

    def test_known_zero_capacity_and_shared_grid_capacity_block(self):
        d=data();d['grids'][0]['properties']['availableKva']=0
        self.assertEqual(local_candidates(self.study(d),at(1050),200)['features'],[])
        d=data();d['grids'][0]['properties']['availableKva']=100
        first=local_candidates(self.study(d),at(1050),200)['features'][0]
        self.assertEqual(local_candidates(self.study(d,additions=[first]),at(1050),200)['features'],[])

    def test_reconfirm_rejects_stale_candidate_and_outside_center(self):
        engine=self.study();feature=local_candidates(engine,at(1050),200)['features'][0]
        request=LocalSitingRequest(center=at(1050),radiusMeters=200,candidateId=feature['properties']['id'])
        with patch('backend.planning_api.study',return_value=engine):
            self.assertEqual(confirm_nearby_site(request)['geometry'],feature['geometry'])
        engine=self.study(additions=[feature])
        with patch('backend.planning_api.study',return_value=engine):
            with self.assertRaises(HTTPException) as error:confirm_nearby_site(request)
            self.assertEqual(error.exception.status_code,422)
        with self.assertRaises(ValueError):local_candidates(self.study(),at(4000),1000)


if __name__=='__main__':unittest.main()
