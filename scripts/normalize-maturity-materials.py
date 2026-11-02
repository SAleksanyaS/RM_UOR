"""Deterministically extract the explicitly authorized originals. Python stdlib only."""
import json, hashlib, zipfile, re, uuid, csv
from pathlib import Path
from xml.etree import ElementTree as E
from decimal import Decimal
ROOT=Path(__file__).resolve().parents[1]
BASE=ROOT/'materials/maturity/2026-10-30'
NS={'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main','a':'http://schemas.openxmlformats.org/drawingml/2006/main','p':'http://schemas.openxmlformats.org/presentationml/2006/main'}
def ident(key): return str(uuid.UUID(bytes=hashlib.sha256(('uor:maturity:2026-10-30:'+key).encode()).digest()[:16],version=4))
def write(p,v): p.write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
def dec(v): return format(Decimal(str(v).strip().replace('%','').replace(',','.').replace('\u00a0','').replace(' ','')).normalize(), 'f')
sources=[{'kind':kind,'path':str((BASE/name).relative_to(ROOT)),'sha256':hashlib.sha256((BASE/name).read_bytes()).hexdigest(),'bytes':(BASE/name).stat().st_size} for kind,name in [('xlsx','source.xlsx'),('pptx','source.pptx')]]
with zipfile.ZipFile(BASE/'source.xlsx') as z:
 strings=[''.join(t.itertext()) for t in E.fromstring(z.read('xl/sharedStrings.xml')).findall('s:si',NS)]
 rows=[]
 for row in E.fromstring(z.read('xl/worksheets/sheet1.xml')).findall('s:sheetData/s:row',NS):
  cells={}
  for c in row.findall('s:c',NS):
   v=c.find('s:v',NS)
   if v is not None: cells[re.sub(r'\d','',c.attrib['r'])]=strings[int(v.text)] if c.get('t')=='s' else v.text
  rows.append({'row':int(row.get('r')),'cells':cells})
orgs={};teams=[];metrics={};observations=[];rollups=[]
for r in rows[1:]:
 c=r['cells'];n=r['row'];level=next(k for k in 'GFEDCBA' if c.get(k)); source={'kind':'xlsx','sheet':'Sheet1','row':n,'cell':f'{level}{n}'}
 for col,kind,parent in [('A','block',None),('B','tribe','A'),('C','cluster','B')]:
  if c.get(col):
   key='org:'+kind+':'+c[col]
   orgs[key]={'id':ident(key),'kind':kind,'name':c[col],'parentId':ident('org:'+{'B':'block','C':'tribe'}[col]+':'+c[parent]) if parent else None,'source':{**source,'cell':f'{col}{n}'}} if key not in orgs else orgs[key]
 if level=='D':
  m=re.fullmatch(r'(.*) \(([^()]+)\)',c['D']);assert m
  teams.append({'id':ident('team:'+m[2]),'code':m[2],'name':m[1],'sourceName':c['D'],'clusterId':ident('org:cluster:'+c['C']),'source':source})
 if level=='G':
  name=c['G'];metricId=ident('metric:'+name);code=re.search(r'\(([^()]+)\)$',c['D'])[1]
  metrics.setdefault(name,{'id':metricId,'name':name,'target':dec(c['O']),'source':{**source,'cell':f'G{n}'}})
  raw=str(c.get('N',''));state={'В исключениях':'exception','Нет PR':'no_event','Нет данных':'missing'}.get(raw.strip(),'numeric')
  observations.append({'id':ident('observation:'+str(n)),'teamId':ident('team:'+code),'metricId':metricId,'state':state,'value':dec(raw) if state=='numeric' else None,'target':dec(c['O']),'raw':raw,'source':{**source,'cell':f'N{n}'},'targetCell':f'O{n}'})
 else:rollups.append({'grain':{'A':'block','B':'tribe','C':'cluster','D':'team','E':'app_stage','F':'practice_group'}[level],'source':source,'cells':c})
leaders=[];mapping=[]
with zipfile.ZipFile(BASE/'source.pptx') as z:
 for slide in range(3,11):
  shapes={}
  for s in E.fromstring(z.read(f'ppt/slides/slide{slide}.xml')).findall('.//p:sp',NS):
   prop=s.find('p:nvSpPr/p:cNvPr',NS);shapes[int(prop.get('id'))]=''.join(t.text or '' for t in s.findall('.//a:t',NS))
  name=shapes[9].split(' — ')[0];leader={'id':ident('leader:'+name),'name':name,'teamIds':[],'source':{'kind':'pptx','slide':slide,'shapeId':'9'}}
  for shapeId in sorted(k for k in shapes if k>=47 and (k-47)%8==0):
   matches=[t for t in teams if t['name'].casefold()==shapes[shapeId].casefold()];assert len(matches)==1,(slide,shapeId,shapes[shapeId])
   t=matches[0];leader['teamIds'].append(t['id']);mapping.append({'teamId':t['id'],'leaderId':leader['id'],'source':{'kind':'pptx','slide':slide,'shapeId':str(shapeId)},'xlsxCell':t['source']['cell'],'verified':'exact_unique_name_match','previousReportedFraction':shapes.get(shapeId+2),'currentReportedFraction':shapes.get(shapeId+4)})
  leaders.append(leader)
assert len(teams)==58 and len(observations)==290 and len(rollups)==434 and sum(len(l['teamIds']) for l in leaders)==58
claims=[{'period':date,'teamsMet':tm,'teamsAvailable':58,'metricsMet':mm,'metricsAvailable':ma,'authority':'source_reported','source':{'kind':'pptx','slide':1,'shapeId':'16' if date=='2026-10-30' else '18'}} for date,tm,mm,ma in [('2026-10-30',56,271,273),('2026-10-25',54,270,274)]]
bundle={'schemaVersion':1,'importVersion':'maturity-ooxml-v1','id':ident('bundle'),'period':'2026-10-30','sources':sources,'organizations':list(orgs.values()),'teams':teams,'metrics':list(metrics.values()),'leaders':leaders,'verifiedMappings':mapping,'observations':observations,'rollups':rollups,'reportedClaims':claims,'declaredGoal':{'target':'80','authority':'source_declared_unverified','source':{'kind':'pptx','slide':1,'shapeId':'12'}},'limitations':['Применимость 15 исключений и случая «Нет PR» не утверждена методикой.','Нет данных: Sheet1!N311; источник исключил позицию из доступного знаменателя.','25 октября: только опубликованные агрегаты; сопоставимые исходные факты отсутствуют.','Квартальный ориентир 80% не является подтверждением УОР.']}
write(ROOT/'data/reference/maturity-2026-10-30.json',bundle)
with (ROOT/'data/reference/maturity-2026-10-30.csv').open('w',encoding='utf8',newline='') as out:
 writer=csv.writer(out,delimiter=';');writer.writerow(['row','teamCode','date']+[f'metric_{i}' for i in range(5)]+[f'state_{i}' for i in range(5)])
 for t in teams:
  obs=[next(o for o in observations if o['teamId']==t['id'] and o['metricId']==m['id']) for m in metrics.values()]
  writer.writerow([t['code'],t['code'],'2026-10-30']+[o['value'] if o['state']=='numeric' else '' for o in obs]+[o['raw'] if o['state']!='numeric' else 'numeric' for o in obs])
write(BASE/'manifest.json',{'schemaVersion':1,'importVersion':bundle['importVersion'],'authorization':'Selected XLSX/PPTX business originals and derived records explicitly authorized for main; excludes credentials, profiles, private config/runtime.','sources':sources,'normalizedPath':'data/reference/maturity-2026-10-30.json','normalizedCsvPath':'data/reference/maturity-2026-10-30.csv','normalizedCsvSha256':hashlib.sha256((ROOT/'data/reference/maturity-2026-10-30.csv').read_bytes()).hexdigest(),'normalizedSha256':hashlib.sha256((ROOT/'data/reference/maturity-2026-10-30.json').read_bytes()).hexdigest(),'counts':{'blocks':1,'tribes':3,'clusters':24,'teams':58,'metrics':5,'leaders':8,'memberships':58,'leaves':290,'rollups':434,'numeric':273,'met':271,'exception':15,'noEvent':1,'missing':1}})
print('Normalized 58 teams, 290 leaf slots, 434 rollups, 8 leaders / 58 mappings')
