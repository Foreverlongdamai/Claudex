# 生成各种格式的测试文件（每个文件里放一个独特的标记词，用来确认内容真的被读出来了）
# 用法：python make_samples.py <输出目录>
import os
import subprocess
import sys

from docx import Document
from openpyxl import Workbook
from pptx import Presentation

out = sys.argv[1]
os.makedirs(out, exist_ok=True)

d = Document()
d.add_heading('项目周报（测试）', 1)
d.add_paragraph('本周完成：内置终端。标记词：青松-DOCX-7731。')
t = d.add_table(rows=2, cols=2)
t.cell(0, 0).text, t.cell(0, 1).text, t.cell(1, 0).text, t.cell(1, 1).text = '任务', '状态', 'C2 Git 审查', '进行中'
d.save(os.path.join(out, '周报.docx'))

p = Presentation()
s = p.slides.add_slide(p.slide_layouts[1])
s.shapes.title.text = '季度汇报（测试）'
s.placeholders[1].text = '标记词：白鹭-PPTX-4410\n收入增长 12%'
p.save(os.path.join(out, '汇报.pptx'))

wb = Workbook()
ws = wb.active
ws.append(['产品', '销量', '备注'])
ws.append(['Claudex', 128, '标记词：红杉-XLSX-9052'])
wb.save(os.path.join(out, '销量.xlsx'))
print('docx/pptx/xlsx ok')

# PDF 和老格式（.doc .xls .ppt）用 LibreOffice 转出来
soffice = r'C:\Program Files\LibreOffice\program\soffice.com'
for src, fmt in [('周报.docx', 'pdf'), ('周报.docx', 'doc'), ('销量.xlsx', 'xls'), ('汇报.pptx', 'ppt')]:
    subprocess.run([soffice, '--headless', '--convert-to', fmt, '--outdir', out, os.path.join(out, src)],
                   check=True, capture_output=True, timeout=120)
print('pdf/doc/xls/ppt ok:', sorted(os.listdir(out)))
