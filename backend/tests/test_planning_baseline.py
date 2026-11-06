import unittest
from unittest.mock import patch
from backend.catalog.station_catalog import station_properties
from backend.core.planning_demand import activities
from backend.api.baseline_data import time_profiles

class PlanningBaselineTests(unittest.TestCase):
    def test_unknown_charge_type_and_evidence_remain_unknown(self):
        result=station_properties('not-verified','真实地图地点',None,{'is_synthetic':False,'baseline_record':{'public_access':None,'scope_review_flags':['重卡']}})
        self.assertIsNone(result['chargeType'])
        self.assertIsNone(result['publicAccess'])
        self.assertIsNone(result['powerKw'])
        self.assertIsNone(result['availableCount'])
        self.assertEqual(result['scopeReviewFlags'],['重卡'])
        self.assertEqual(result['simulatedFields'],[])

    def test_new_unified_categories_feed_matching_activities(self):
        for category,expected in [('work','work'),('public_service','public'),('parking','public'),('government_transport','public'),('commercial','shopping')]:
            self.assertEqual(activities({'properties':{'categories':[category]}}),[expected])

    @patch('backend.api.baseline_data.catalog')
    def test_observed_profile_units_not_changed_to_arrival_probability(self,catalog):
        catalog.return_value=[{'interval_index':'0','day_type':'weekday','driving_ratio':'0.1','charging_ratio':'0.2','parked_ratio':'0.7'}]
        response=time_profiles()
        self.assertEqual(response['profiles'][0]['charging_ratio'],.2)
        self.assertEqual(response['metadata']['basis'],'observed_external_aggregate')
        self.assertEqual(response['metadata']['unit'],'时点车辆状态比例')
        self.assertIn('不等于',response['metadata']['notice'])

if __name__=='__main__':unittest.main()
