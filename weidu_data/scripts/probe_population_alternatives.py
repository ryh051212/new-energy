import json,re
from pathlib import Path
import requests
out=Path(__file__).resolve().parents[1]
urls={
 'worldpop_stac_api':'https://api.stac.worldpop.org/collections/CHN/items/chn_pop_2025_CN_100m_R2025A_v1',
 'ghsl_3ss':'https://jeodpp.jrc.ec.europa.eu/ftp/jrc-opendata/GHSL/GHS_POP_GLOBE_R2023A/GHS_POP_E2025_GLOBE_R2023A_4326_3ss/V1-0/',
 'ghsl_100m':'https://jeodpp.jrc.ec.europa.eu/ftp/jrc-opendata/GHSL/GHS_POP_GLOBE_R2023A/GHS_POP_E2025_GLOBE_R2023A_54009_100/V1-0/',
 'ghsl_3ss_tiles':'https://jeodpp.jrc.ec.europa.eu/ftp/jrc-opendata/GHSL/GHS_POP_GLOBE_R2023A/GHS_POP_E2025_GLOBE_R2023A_4326_3ss/V1-0/tiles/',
}
for name,url in urls.items():
 try:
  r=requests.get(url,timeout=40);r.raise_for_status()
  (out/'raw'/(name+'.txt')).write_bytes(r.content)
  if name=='worldpop_stac_api':print(name,json.dumps(r.json().get('assets'),ensure_ascii=False),flush=True)
  elif name=='ghsl_3ss_tiles':print(name,[x for x in r.text.splitlines() if 'R6_C30' in x or 'R6_C29' in x or 'R6_C' in x][:5],re.findall(r'href="([^"]+)"',r.text)[5:10],flush=True)
  else:print(name,re.findall(r'href="([^"]+)"',r.text)[-25:],flush=True)
 except requests.RequestException as e:print(name,type(e).__name__,flush=True)
