"""Read-only XLSX verification using the standard library. No macros/external execution."""
import json,sys,zipfile,posixpath,xml.etree.ElementTree as ET
expected=json.load(open(sys.argv[2],encoding='utf-8'))
ns={'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main','r':'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}
def xml(z,name):return ET.fromstring(z.read(name))
with zipfile.ZipFile(sys.argv[1]) as z:
    if sum(i.file_size for i in z.infolist())>64*1024*1024:raise ValueError('Expanded workbook too large')
    workbook=xml(z,'xl/workbook.xml');rels={r.attrib['Id']:r.attrib['Target'] for r in xml(z,'xl/_rels/workbook.xml.rels')}
    sheet=next((s for s in workbook.find('s:sheets',ns) if s.attrib['name']==expected['sheet_name']),None)
    if sheet is None:raise ValueError('Target sheet not found in export')
    target=rels[sheet.attrib['{'+ns['r']+'}id']]
    path=target.lstrip('/') if target.startswith('/') else posixpath.normpath('xl/'+target)
    doc=xml(z,path);shared=[]
    if 'xl/sharedStrings.xml' in z.namelist():shared=[''.join(t.text or '' for t in si.findall('.//s:t',ns)) for si in xml(z,'xl/sharedStrings.xml')]
    cells={c.attrib['r']:c for c in doc.findall('.//s:sheetData/s:row/s:c',ns)}
    styles=xml(z,'xl/styles.xml');fonts=styles.find('s:fonts',ns);xfs=styles.find('s:cellXfs',ns);fills=styles.find('s:fills',ns)
    body_ok=True;style_ok=True;link_ok=True
    for r,row in enumerate(expected['rows'],1):
        for c,text in enumerate(row):
            ref=chr(65+c)+str(r);cell=cells.get(ref)
            if cell is None:
                if text:body_ok=False
                continue
            val=cell.find('s:v',ns);v=val.text if val is not None else ''
            if cell.attrib.get('t')=='s':v=shared[int(v)]
            elif cell.attrib.get('t')=='inlineStr':v=''.join(t.text or '' for t in cell.findall('s:is//s:t',ns))
            if (v or '')!=text:body_ok=False
            xf=xfs[int(cell.attrib.get('s','0'))];font=fonts[int(xf.attrib.get('fontId','0'))];name=font.find('s:name',ns);alignment=xf.find('s:alignment',ns)
            if name is None or name.attrib.get('val')!='微软雅黑' or alignment is None or alignment.attrib.get('wrapText') not in ['1','true'] or alignment.attrib.get('vertical')!='top':style_ok=False
            color={'低档':'FFE8F3EA','中档':'FFE8F0FC','高档':'FFFFEEDF'}.get(row[0])
            if color:
                fill=fills[int(xf.attrib.get('fillId','0'))].find('s:patternFill/s:fgColor',ns)
                if fill is None or fill.attrib.get('rgb','').upper()!=color:style_ok=False
    relpath=posixpath.dirname(path)+'/_rels/'+posixpath.basename(path)+'.rels'
    links={r.attrib['Id']:r.attrib.get('Target') for r in xml(z,relpath)} if relpath in z.namelist() else {}
    actual={h.attrib['ref']:links.get(h.attrib.get('{'+ns['r']+'}id')) for h in doc.findall('s:hyperlinks/s:hyperlink',ns)}
    for h in expected['links']:
        if actual.get(chr(65+h['col'])+str(h['row']+1))!=h['url']:link_ok=False
    print(json.dumps({'content':body_ok,'links':link_ok,'styles':style_ok,'scope':'exported XLSX properties; not screen visual acceptance'}))
