"""Fetch publisher/government source documents without bypassing access controls."""
import json
import hashlib
from datetime import datetime,timezone
from pathlib import Path
import requests

ROOT=Path(__file__).resolve().parents[1]
refs=json.loads((ROOT/'metadata/reference_sources.json').read_text(encoding='utf-8'))
results=[]
for ref in refs:
 target=ROOT/'raw/references';target.mkdir(parents=True,exist_ok=True)
 previous=list(target.glob(ref['id']+'.*'))
 if previous:
  results.append({**ref,'acquisition_status':'已实际获取','local_file':previous[0].relative_to(ROOT).as_posix(),'note':'previously downloaded in this task'})
  continue
 try:
  r=requests.get(ref['url'],timeout=(15,35),headers={'User-Agent':'WeiduGIS-StudentResearch/1.0 (academic source documentation)'})
  r.raise_for_status()
  ext='.pdf' if r.content[:4]==b'%PDF' else '.json' if 'json' in r.headers.get('Content-Type','') else '.html'
  path=target/(ref['id']+ext);path.write_bytes(r.content)
  results.append({**ref,'acquisition_status':'已实际获取','local_file':path.relative_to(ROOT).as_posix(),'http_status':r.status_code,'bytes':len(r.content),'sha256':hashlib.sha256(r.content).hexdigest(),'downloaded_at':datetime.now(timezone.utc).isoformat()})
  print(ref['id'],r.status_code,len(r.content),flush=True)
 except requests.RequestException as e:
  results.append({**ref,'acquisition_status':'可下载但尚未获取' if getattr(e,'response',None) is None or e.response.status_code not in (401,403) else '需要申请','error_kind':type(e).__name__,'http_status':e.response.status_code if getattr(e,'response',None) is not None else None,'note':'No bypass attempted; web search verification may be available separately.'})
  print(ref['id'],type(e).__name__,flush=True)
(ROOT/'metadata/reference_downloads.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
