"""Read-only bounded XLSX region verification; does not evaluate formulas/macros."""
import json,sys,zipfile,posixpath,xml.etree.ElementTree as ET
x=json.load(open(sys.argv[2],encoding='utf-8'))
assert isinstance(x['start_row'],int) and 0<=x['start_row']<2000
assert 0<len(x['rows'])<=2000 and all(isinstance(r,list) and 1<=len(r)<=9 and all(isinstance(v,str) for v in r) for r in x['rows'])
ns={'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main','r':'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}
def xml(z,path):
    assert not path.startswith('/') and '..' not in path.split('/')
    return ET.fromstring(z.read(path))
with zipfile.ZipFile(sys.argv[1]) as z:
    assert sum(i.file_size for i in z.infolist())<=64*1024*1024
    book=xml(z,'xl/workbook.xml');rels={r.attrib['Id']:r.attrib['Target'] for r in xml(z,'xl/_rels/workbook.xml.rels')}
    matches=[s for s in book.find('s:sheets',ns) if s.attrib['name']==x['sheet_name']];assert len(matches)==1
    target=rels[matches[0].attrib['{'+ns['r']+'}id']]
    path=target.lstrip('/') if target.startswith('/') else posixpath.normpath('xl/'+target)
    doc=xml(z,path);shared=[]
    if 'xl/sharedStrings.xml' in z.namelist():shared=[''.join(t.text or '' for t in si.findall('.//s:t',ns)) for si in xml(z,'xl/sharedStrings.xml')]
    raw=doc.findall('.//s:sheetData/s:row/s:c',ns);cells={c.attrib['r']:c for c in raw};assert len(cells)==len(raw)
    content=True
    for r,row in enumerate(x['rows'],x['start_row']+1):
        for c,expected in enumerate(row):
            cell=cells.get(chr(65+c)+str(r))
            if cell is None:
                if expected:content=False
                continue
            if cell.find('s:f',ns) is not None:content=False;continue
            t=cell.attrib.get('t');v=cell.find('s:v',ns);value=v.text or '' if v is not None else ''
            if t=='s':value=shared[int(value)]
            elif t=='inlineStr':value=''.join(a.text or '' for a in cell.findall('s:is//s:t',ns))
            elif t not in ['str',None]:content=False
            elif t is None and value:content=False
            if value!=expected:content=False
    relpath=posixpath.dirname(path)+'/_rels/'+posixpath.basename(path)+'.rels'
    linkrels={r.attrib['Id']:r.attrib.get('Target') for r in xml(z,relpath)} if relpath in z.namelist() else {}
    actual={h.attrib['ref']:linkrels.get(h.attrib.get('{'+ns['r']+'}id')) for h in doc.findall('s:hyperlinks/s:hyperlink',ns)}
    links=all(actual.get(chr(65+h['col'])+str(h['row']+1))==h['url'] for h in x['links'])
    print(json.dumps({'content':content,'links':links,'styles':False,'scope':'bounded exported region text and hyperlinks; styles not certified'}))
