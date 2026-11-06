import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from fastapi import FastAPI, HTTPException
from shapely.geometry import Polygon, shape
from backend import siting_context as context
from tests.backend.test_auth_cors import asgi_request


def geometry(coords):
    return [{'lon':lon,'lat':lat} for lon,lat in coords]


class SitingContextTests(unittest.TestCase):
    def test_geometries_holes_boundaries_and_evidence_do_not_create_approval(self):
        outer=[[113,34],[113.02,34],[113.02,34.02],[113,34.02],[113,34]]
        inner=[[113.005,34.005],[113.015,34.005],[113.015,34.015],[113.005,34.015],[113.005,34.005]]
        raw={'elements':[
            {'type':'relation','id':1,'tags':{'type':'multipolygon','natural':'water'},'members':[
                {'type':'way','role':'outer','geometry':geometry(outer)},
                {'type':'way','role':'inner','geometry':geometry(inner)}]},
            {'type':'node','id':2,'lon':113.001,'lat':34.001,'tags':{'power':'transformer'}},
            {'type':'node','id':3,'lon':114,'lat':35,'tags':{'amenity':'parking'}},
            {'type':'node','id':4,'lon':True,'lat':34,'tags':{'amenity':'parking'}},
        ]}
        facility={'id':'exact','name':'测试停车场','lng':113.001,'lat':34.001,'categories':['parking'],
            'source_url':'https://www.amap.com/place/exact','address':'测试路','typecode':'150904','raw':{},'fetched_at':'2026-10-01'}
        evidence={'parking':[{'amapId':'exact','expectedName':'测试停车场','capacity':524,'capacityKind':'design'}]}
        result=context.normalize_context(raw,[facility],Polygon(outer),evidence)
        self.assertEqual(len(result['features']),3)
        self.assertEqual(result['metadata']['skippedGeometryCount'],1)
        water=result['features'][0]
        self.assertEqual(len(water['geometry']['coordinates']),2)
        self.assertFalse(shape(water['geometry']).covers(shape({'type':'Point','coordinates':[113.01,34.01]})))
        self.assertEqual(result['features'][-1]['properties']['capacityKind'],'design')
        for feature in result['features']:
            self.assertFalse({'roadAccess','sitePermission','fireSafety','availableKva','parkingSpaces'} & feature['properties'].keys())
        facility['name']='其他停车场'
        self.assertNotIn('capacity',context.normalize_context(raw,[facility],Polygon(outer),evidence)['features'][-1]['properties'])

    def test_parking_entry_type_code_and_zero_capacity(self):
        raw={'elements':[{'type':'node','id':1,'lon':113,'lat':34,'tags':{'amenity':'parking','capacity':'0'}}]}
        border=Polygon([[112,33],[114,33],[114,35],[112,35],[112,33]])
        result=context.normalize_context(raw,[],border,{})
        self.assertEqual(result['features'][0]['properties']['capacity'],0)
        self.assertEqual(result['features'][0]['properties']['capacityKind'],'mapped')
        with self.assertRaises(ValueError):
            context.normalize_context({'remark':'timeout','elements':[]},[],border,{})

    def test_local_api_and_document_allowlist(self):
        app=FastAPI()
        app.include_router(context.router)
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'context.json'
            with patch.object(context,'CONTEXT_PATH',path):
                status,_,_,_=asyncio.run(asgi_request(app,'/api/siting-context'))
                self.assertEqual(status,503)
                path.write_text(json.dumps({'type':'FeatureCollection','features':[],'metadata':{'evidenceOnly':True}}),encoding='utf-8')
                status,_,body,_=asyncio.run(asgi_request(app,'/api/siting-context'))
                self.assertEqual(status,200)
                self.assertTrue(json.loads(body)['metadata']['evidenceOnly'])
        with self.assertRaises(HTTPException) as error:
            context.get_document('../../backend/.env')
        self.assertEqual(error.exception.status_code,404)
        response=context.get_document('parking-roadside')
        self.assertEqual(response.media_type,'image/jpeg')
        self.assertTrue(Path(response.path).is_file())
