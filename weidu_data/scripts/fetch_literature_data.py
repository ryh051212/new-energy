"""Download small, CC-BY-4.0 published figure datasets from the authors' archive."""
import hashlib,json,time
from pathlib import Path
import requests
ROOT=Path(__file__).resolve().parents[1]
catalog=json.loads((ROOT/'raw/references/zhan_2025_data.json').read_text(encoding='utf-8'))
chosen=['Fig2a.','Fig3-1.','Fig3-2.','Fig1f-2.','Fig1e.']
manifest=[]
for entry in catalog['files']:
 if not any(entry['key'].startswith(prefix) for prefix in chosen):continue
 target=ROOT/'parameters/literature_observed'/entry['key'];target.parent.mkdir(parents=True,exist_ok=True)
 for attempt in range(3):
  try:
   r=requests.get(entry['links']['self'],timeout=(15,40));r.raise_for_status()
   checksum=entry.get('checksum','')
   if checksum.startswith('md5:') and hashlib.md5(r.content).hexdigest()!=checksum[4:]:raise ValueError('Author archive checksum mismatch')
   target.write_bytes(r.content)
   manifest.append({'name':entry['key'],'url':entry['links']['self'],'bytes':len(r.content),'sha256':hashlib.sha256(r.content).hexdigest(),'archive_checksum':checksum,'doi':'10.5281/zenodo.13852045','license':'CC-BY-4.0','observation_period':'2020-11 to 2021-10','geography':'Seven major Chinese cities; NOT Xuchang or Weidu','kind':'empirical aggregate figure data, not individual trajectories'})
   print(entry['key'],len(r.content),repr(r.content[:220]),flush=True);break
  except requests.RequestException as e:
   print('Download retry',attempt+1,type(e).__name__,flush=True)
   if attempt==2:raise
   time.sleep(2)
(ROOT/'metadata/literature_data_downloads.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
