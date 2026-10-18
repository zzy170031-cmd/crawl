"""Synthetic OOXML test; not a real Tencent export acceptance."""
import pathlib,tempfile,zipfile,json,subprocess,sys
base=pathlib.Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='crawl-xlsx-') as tmp:
    p=pathlib.Path(tmp)
    def book(text='正文',font='微软雅黑',link='https://example.com/source'):
        files={
        'xl/workbook.xml':'<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="测试" sheetId="1" r:id="rId1"/></sheets></workbook>',
        'xl/_rels/workbook.xml.rels':'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
        'xl/styles.xml':f'<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts><font><name val="{font}"/></font></fonts><fills><fill><patternFill/></fill></fills><cellXfs><xf fontId="0" fillId="0"><alignment wrapText="1" vertical="top"/></xf></cellXfs></styleSheet>',
        'xl/worksheets/sheet1.xml':f'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetData><row r="1"><c r="A1" t="inlineStr" s="0"><is><t>{text}</t></is></c></row></sheetData><hyperlinks><hyperlink ref="A1" r:id="link1"/></hyperlinks></worksheet>',
        'xl/worksheets/_rels/sheet1.xml.rels':f'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="link1" Target="{link}" TargetMode="External"/></Relationships>'}
        with zipfile.ZipFile(p/'test.xlsx','w') as z:
            for name,body in files.items():z.writestr(name,body)
    (p/'expected.json').write_text(json.dumps({'sheet_name':'测试','rows':[['正文']],'links':[{'row':0,'col':0,'url':'https://example.com/source'}]}),encoding='utf-8')
    def verify():return json.loads(subprocess.check_output([sys.executable,str(base/'app/verify_xlsx.py'),str(p/'test.xlsx'),str(p/'expected.json')]))
    book();result=verify();assert result['content'] and result['links'] and result['styles']
    book(text='人工修改',font='Other',link='https://example.com/wrong');result=verify();assert not result['content'] and not result['links'] and not result['styles']
    print('2 synthetic XLSX verification scenarios passed')
