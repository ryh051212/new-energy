import unittest
from copy import deepcopy

from backend.station_equipment import apply_station_equipment, equipment_catalog, reviewed_equipment
from backend.station_catalog import station_properties


class StationEquipmentTests(unittest.TestCase):
    def properties(self, station_id, **changes):
        record = equipment_catalog()['stations'][station_id]
        return dict(id=station_id, name=record['stationName'], dataSource='existing-poi',
                    isSynthetic=False, totalCount=99, powerKw=180,
                    simulatedFields=['totalCount', 'powerKw'], **changes)

    def test_dual_guns_do_not_double_device_capacity_or_invent_per_gun_power(self):
        for station_id, piles, guns, capacity in [('B0IAM64GE0', 14, 28, 1680), ('B0IAPCQBO7', 8, 16, 960)]:
            catalog = equipment_catalog()
            # 明确声明完整配置的测试夹具验证双枪汇总；实际存档缺原文复核，保持部分线索。
            record = {**catalog['stations'][station_id], 'complete': True}
            equipment = reviewed_equipment(record, catalog)
            self.assertEqual((equipment['pileCount'], equipment['gunCount'], equipment['installedPowerKw']), (piles, guns, capacity))
            self.assertIsNone(equipment['maxGunPowerKw'])
            self.assertIsNone(equipment['groups'][0]['gunPowerKw'])
            result = apply_station_equipment(self.properties(station_id))
            self.assertIsNone(result['installedPowerKw'])
            self.assertIsNone(result['gunCount'])
            self.assertEqual(result['totalCount'], 99)
            self.assertEqual(result['simulatedFields'], ['totalCount', 'powerKw'])

    def test_tesla_site_maximum_does_not_become_station_capacity_or_gun_inventory(self):
        for station_id, maximum in [('B0FFJ5K41S', 119), ('B0I1NS8N4O', 250)]:
            result = apply_station_equipment(self.properties(station_id))
            self.assertEqual(result['pileCount'], 6)
            self.assertEqual(result['maxGunPowerKw'], maximum)
            self.assertIsNone(result['gunCount'])
            self.assertIsNone(result['installedPowerKw'])
            self.assertIsNone(result['chargingEquipment']['groups'][0]['gunPowerKw'])

    def test_shared_power_cabinets_not_counted_twice(self):
        equipment = apply_station_equipment(self.properties('B0IKHSCAZG'))['chargingEquipment']
        self.assertEqual((equipment['pileCount'], equipment['gunCount'], equipment['installedPowerKw']), (20, 26, 1294))
        self.assertEqual([g['gunCount'] for g in equipment['groups']], [8, 4, 12, 2])
        self.assertEqual([g['gunPowerKw'] for g in equipment['groups']], [40, 60, None, 7])

    def test_conflicting_and_ambiguous_directory_counts_stay_partial(self):
        for station_id in ('B0L0RM563D', 'B0IA6LE8RO', 'B0J2XPOV8J'):
            result = apply_station_equipment(self.properties(station_id))
            self.assertIsNone(result['pileCount'])
            self.assertIsNone(result['gunCount'])
            self.assertIsNone(result['installedPowerKw'])
            self.assertFalse(result['chargingEquipment']['complete'])
        result = apply_station_equipment(self.properties('B0L0RM563D'))
        self.assertEqual(result['maxGunPowerKw'], 600)
        self.assertTrue(all(g['unitPowerKw'] is None for g in result['chargingEquipment']['groups']))

    def test_invalid_evidence_and_values_never_supply_capacity(self):
        catalog = equipment_catalog()
        original = catalog['stations']['B0IAM64GE0']
        for change in ({'checkedAt': '2099-01-01T00:00:00Z'}, {'sources': []}, {'maxGunPowerKw': float('nan')}):
            with self.subTest(change=change):
                result = reviewed_equipment({**original, **change}, catalog)
                self.assertEqual(result['state'], 'unknown')
                self.assertIsNone(result['installedPowerKw'])
        for field, value in [('unitCount', True), ('unitCount', -1), ('unitCount', 1.5),
                             ('unitPowerKw', float('inf')), ('gunPowerKw', 121)]:
            record = deepcopy(original)
            record['groups'][0][field] = value
            self.assertEqual(reviewed_equipment(record, catalog)['state'], 'unknown')
        invalid_catalog = deepcopy(catalog)
        invalid_catalog['sources']['city-2023']['url'] = 'javascript:alert(1)'
        self.assertEqual(reviewed_equipment(original, invalid_catalog)['state'], 'unknown')

    def test_identity_and_real_data_boundaries(self):
        station_id = 'B0FFJ5K41S'
        original = self.properties(station_id)
        for change in ({'isSynthetic': True}, {'dataSource': 'field-survey'}):
            properties = {**original, **change}
            self.assertEqual(apply_station_equipment(deepcopy(properties)), properties)
        for change in ({'name': '同址另一运营方'}, {'id': 'unknown-poi'}):
            result = apply_station_equipment({**original, **change})
            self.assertEqual(result['chargingEquipment']['state'], 'unknown')
            self.assertIsNone(result['pileCount'])
        real = station_properties(station_id, original['name'], '原地址', {'data_source': 'existing-poi'})
        self.assertEqual(real['maxGunPowerKw'], 119)
        self.assertEqual(real['fieldVerification']['maxGunPowerKw']['state'], 'known')
        self.assertNotIn('availabilityIsRealtime', real)


if __name__ == '__main__':
    unittest.main()
