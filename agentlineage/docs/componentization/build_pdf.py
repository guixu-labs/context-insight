"""Render the consolidated Markdown manual to a Chinese PDF with linked TOC.

Requires reportlab. Run from any directory; Markdown is the maintained source.
"""
from __future__ import annotations

import argparse
import html
import json
import re
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    BaseDocTemplate, CondPageBreak, Flowable, Frame, KeepTogether, LongTable, PageBreak,
    PageTemplate, Paragraph, Spacer, Table, TableStyle,
)
from reportlab.platypus.tableofcontents import TableOfContents

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
INK = colors.HexColor('#172C40')
BLUE = colors.HexColor('#155B89')
TEAL = colors.HexColor('#00847F')
MUTED = colors.HexColor('#5D6E7D')
LIGHT = colors.HexColor('#EEF3F7')
BORDER = colors.HexColor('#D6E0E7')
PAGE_W, PAGE_H = A4
LEFT, RIGHT, TOP, BOTTOM = 45, 45, 52, 46
CONTENT_W = PAGE_W - LEFT - RIGHT


def register_fonts(font_dir: Path):
    for name, filename in [('CN', 'msyh.ttc'), ('CNBold', 'msyhbd.ttc'),
                           ('Mono', 'consola.ttf')]:
        pdfmetrics.registerFont(TTFont(name, str(font_dir / filename)))
    pdfmetrics.registerFontFamily('CN', normal='CN', bold='CNBold', italic='CN', boldItalic='CNBold')
    pdfmetrics.registerFontFamily('Mono', normal='Mono', bold='Mono', italic='Mono', boldItalic='Mono')


def slug(value):
    return re.sub(r'[^\w\-\s]', '', value.lower()).replace(' ', '-')


def plain(value):
    value = re.sub(r'\[([^\]]+)\]\([^)]+\)', r'\1', value)
    return value.replace('**', '').replace('`', '')


def mono_markup(value):
    pieces = re.findall(r'[\x20-\x7e]+|[^\x20-\x7e]+', value)
    return ''.join('<font name="' + ('Mono' if part.isascii() else 'CN') + '">' + html.escape(part) + '</font>' for part in pieces)


class Inline:
    def __init__(self, references):
        self.references = references
        self.in_sources = False

    def __call__(self, value):
        pattern = re.compile(r'(`[^`]+`|\*\*.+?\*\*|\[[^\]]+\]\([^)]+\))')
        chunks = []
        for token in pattern.split(value):
            if token.startswith('`') and token.endswith('`'):
                chunks.append('<font color="#285571">' + mono_markup(token[1:-1]) + '</font>')
            elif token.startswith('**') and token.endswith('**'):
                chunks.append('<b>' + self(token[2:-2]) + '</b>')
            elif re.match(r'^\[[^\]]+\]\([^)]+\)$', token):
                label, target = re.match(r'^\[([^\]]+)\]\(([^)]+)\)$', token).groups()
                if target.startswith('#'):
                    dest = target
                    rendered = self(label)
                elif self.in_sources and not target.startswith('http'):
                    chunks.append('<font color="#36596F">' + html.escape(label) + '</font>')
                    continue
                elif self.in_sources:
                    dest = target
                    rendered = html.escape(label)
                else:
                    dest = '#source-' + self.references[target]
                    rendered = self(label) + ' [S' + self.references[target] + ']'
                chunks.append('<link href="' + html.escape(dest, quote=True) + '" color="#155B89">' + rendered + '</link>')
            else:
                chunks.append(html.escape(token))
        return ''.join(chunks)


class CodeBlock(Flowable):
    """Embedded-font, wrapped and splittable code with CJK fallback."""
    def __init__(self, text='', language='', wrapped=None, continuation=False):
        super().__init__()
        self.text = text
        self.language = language
        self.lines = wrapped
        self.continuation = continuation
        self.size = 8.1
        self.leading = 11.6
        self.padding = 10
        self.spaceBefore = 5
        self.spaceAfter = 9
        self.label_height = 14 if language else 0

    @staticmethod
    def font(char):
        return 'Mono' if ord(char) in pdfmetrics.getFont('Mono').face.charToGlyph else 'CN'

    def text_width(self, text):
        return sum(pdfmetrics.stringWidth(c, self.font(c), self.size) for c in text)

    def wrap(self, availWidth, availHeight):
        self.width = availWidth
        limit = availWidth - 2 * self.padding
        if self.lines is None:
            self.lines = []
            for line in self.text.expandtabs(2).splitlines():
                if not line:
                    self.lines.append('')
                    continue
                current = ''
                for char in line:
                    if self.text_width(current + char) > limit:
                        self.lines.append(current)
                        current = '  ' + char
                    else:
                        current += char
                self.lines.append(current)
        self.height = len(self.lines) * self.leading + self.padding * 2 + self.label_height
        return self.width, self.height

    def split(self, availWidth, availHeight):
        self.wrap(availWidth, availHeight)
        count = int((availHeight - self.padding * 2 - self.label_height) // self.leading)
        if count < 3:
            return []
        if count >= len(self.lines):
            return [self]
        if len(self.lines) <= 14:
            return []
        count = min(count, len(self.lines) - 4)
        if count < 5:
            return []
        first = CodeBlock(language=self.language, wrapped=self.lines[:count], continuation=self.continuation)
        second = CodeBlock(language=self.language, wrapped=self.lines[count:], continuation=True)
        return [first, second]

    def draw(self):
        c = self.canv
        c.setFillColor(colors.HexColor('#F3F6F9'))
        c.roundRect(0, 0, self.width, self.height, 4, fill=1, stroke=0)
        c.setFillColor(colors.HexColor('#B8CEDC'))
        c.rect(0, 0, 2, self.height, fill=1, stroke=0)
        y = self.height - self.padding
        if self.language:
            c.setFillColor(MUTED)
            c.setFont('CN', 7.1)
            c.drawString(self.padding, y - 6, self.language + (' · 续' if self.continuation else ''))
            y -= self.label_height
        c.setFillColor(INK)
        for line in self.lines:
            y -= self.leading
            x = self.padding
            run, font = '', None
            for char in line:
                charfont = self.font(char)
                if font is not None and charfont != font:
                    c.setFont(font, self.size)
                    c.drawString(x, y, run)
                    x += pdfmetrics.stringWidth(run, font, self.size)
                    run = ''
                font = charfont
                run += char
            if run:
                c.setFont(font, self.size)
                c.drawString(x, y, run)


class Anchor(Flowable):
    def __init__(self, name):
        super().__init__()
        self.name = name
        self.width = self.height = 0
        self._ZEROSIZE = True
        self.keepWithNext = True

    def draw(self):
        self.canv.bookmarkHorizontal(self.name, 0, 0)


class ManualDoc(BaseDocTemplate):
    def __init__(self, path, document_title='DSH 组件化接入指南', compact=False, **kwargs):
        super().__init__(path, pagesize=A4, leftMargin=LEFT, rightMargin=RIGHT,
                         topMargin=TOP, bottomMargin=BOTTOM, **kwargs)
        self.running_title = ''
        self.document_title = document_title
        self.compact = compact
        self.heading_records = []
        self.addPageTemplates(PageTemplate(id='main', frames=[Frame(
            LEFT, BOTTOM, CONTENT_W, PAGE_H-TOP-BOTTOM,
            leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0,
            id='content')], onPage=self.page_decoration))

    def beforeDocument(self):
        self.running_title = ''
        self.heading_records = []
        self.canv.setTitle(self.document_title)
        self.canv.setAuthor('组件化工作组')
        self.canv.setSubject('公共接口、Plugin 与 Bundle、DSH 接入启动、项目建议和验收模板')

    def page_decoration(self, canvas, doc):
        canvas.saveState()
        if doc.page > 1 or self.compact:
            canvas.setStrokeColor(BORDER)
            canvas.setLineWidth(.5)
            canvas.line(LEFT, PAGE_H-34, PAGE_W-RIGHT, PAGE_H-34)
            canvas.setFillColor(MUTED)
            canvas.setFont('CN', 8)
            canvas.drawString(LEFT, PAGE_H-26, self.document_title)
            canvas.drawRightString(PAGE_W-RIGHT, PAGE_H-26, '讨论稿 v0.9')
            canvas.line(LEFT, 33, PAGE_W-RIGHT, 33)
            canvas.setFont('CN', 7.8)
            canvas.drawString(LEFT, 21, '2026-10-15  ·  团队接入手册')
            canvas.drawRightString(PAGE_W-RIGHT, 21, str(doc.page))
        canvas.restoreState()

    def afterFlowable(self, flowable):
        if hasattr(flowable, '_heading'):
            depth, title, key, include = flowable._heading
            self.canv.bookmarkPage(key)
            self.canv.addOutlineEntry(title, key, depth, closed=(depth == 0))
            self.heading_records.append({'level': depth, 'title': title, 'key': key, 'page': self.page})
            if include:
                self.notify('TOCEntry', (depth, html.escape(title), self.page, key))


def get_styles():
    base = dict(fontName='CN', fontSize=10, leading=16.2, textColor=INK,
                wordWrap='CJK', splitLongWords=True, allowWidows=0, allowOrphans=0)
    styles = {
        'body': ParagraphStyle('Body', **base, spaceAfter=7),
        'list': ParagraphStyle('List', **base, leftIndent=13, firstLineIndent=-10, spaceAfter=4.5),
        'h2': ParagraphStyle('H2', fontName='CNBold', fontSize=18.5, leading=27,
                             textColor=INK, spaceAfter=14, keepWithNext=True, wordWrap='CJK'),
        'h3': ParagraphStyle('H3', fontName='CNBold', fontSize=12.5, leading=19,
                             textColor=BLUE, spaceBefore=14, spaceAfter=8, keepWithNext=True, wordWrap='CJK'),
        'h4': ParagraphStyle('H4', fontName='CNBold', fontSize=10.5, leading=17,
                             textColor=INK, spaceBefore=9, spaceAfter=5, keepWithNext=True, wordWrap='CJK'),
        'table': ParagraphStyle('Table', fontName='CN', fontSize=8.55, leading=12.7,
                                textColor=INK, wordWrap='CJK', allowWidows=1, allowOrphans=1),
        'tablehead': ParagraphStyle('TableHead', fontName='CNBold', fontSize=8.6, leading=12.8,
                                    textColor=colors.white, wordWrap='CJK'),
        'toc0': ParagraphStyle('TOC0', fontName='CNBold', fontSize=10.3, leading=16,
                               textColor=INK, spaceBefore=4, leftIndent=0, rightIndent=25, wordWrap='CJK'),
        'toc1': ParagraphStyle('TOC1', fontName='CN', fontSize=9.3, leading=13,
                               textColor=MUTED, spaceBefore=0.5, leftIndent=14, rightIndent=25, wordWrap='CJK'),
    }
    return styles


def table_widths(rows):
    n = len(rows[0])
    if n == 2:
        ratios = [.26, .74]
    elif n == 3:
        ratios = [.31, .33, .36] if rows[0] == ['位置', '放什么', '安装与使用时怎样处理'] else [.25, .375, .375]
    elif n == 4:
        if rows[0][0].startswith('ID /'):
            ratios = [.18, .51, .10, .21]
        elif rows[0][0] == '项目':
            ratios = [.16, .28, .30, .26]
        elif rows[0][-1] == '证据位置':
            ratios = [.20, .46, .14, .20]
        elif rows[0][0] == '步骤':
            ratios = [.13, .33, .25, .29]
        else:
            ratios = [.21, .27, .27, .25]
    elif n == 5:
        ratios = [.15, .215, .235, .19, .21]
    else:
        ratios = [1 / n] * n
    return [CONTENT_W * r for r in ratios]


def make_table(rows, inline, styles, compact=False):
    widths = table_widths(rows)
    cell_padding = 3 if compact else (4 if rows[0][-1] == '填写内容' else 5.5)
    cells = [[Paragraph(inline(c), styles['tablehead' if i == 0 else 'table']) for c in row]
             for i, row in enumerate(rows)]
    table = LongTable(cells, colWidths=widths, repeatRows=1, hAlign='LEFT',
                      spaceBefore=5, spaceAfter=11)
    table.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), BLUE),
        ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, colors.HexColor('#F3F6F8')]),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('LEFTPADDING', (0, 0), (-1, -1), 7),
        ('RIGHTPADDING', (0, 0), (-1, -1), 7),
        ('TOPPADDING', (0, 0), (-1, -1), cell_padding),
        ('BOTTOMPADDING', (0, 0), (-1, -1), cell_padding),
        ('LINEBELOW', (0, 0), (-1, 0), .5, BLUE),
        ('LINEBELOW', (0, 1), (-1, -1), .3, BORDER),
    ]))
    return table


def cover(styles):
    def p(text, font, size, leading, color=INK, after=0):
        return Paragraph(text, ParagraphStyle('Cover'+str(size), fontName=font,
                         fontSize=size, leading=leading, textColor=color, spaceAfter=after,
                         wordWrap='CJK'))
    badge = Table([[p('DSH  /  COMPONENTIZATION', 'Mono', 10, 14, colors.white)]],
                  colWidths=[260], hAlign='LEFT')
    badge.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,-1),BLUE),
                               ('TOPPADDING',(0,0),(-1,-1),10),
                               ('BOTTOMPADDING',(0,0),(-1,-1),10),
                               ('LEFTPADDING',(0,0),(-1,-1),12)]))
    return [Spacer(1, 64), badge, Spacer(1, 30),
            p('DSH 组件化<br/>接入指南', 'CNBold', 31, 45),
            Spacer(1, 22), p('复用公共能力，适配目标宿主，验证实际调用', 'CN', 14, 23, MUTED),
            Spacer(1, 34),
            p('SDK · CLI · MCP · HTTP · Skills &amp; Agents · ACP', 'CN', 11, 19, BLUE),
            Spacer(1, 12),
            p('公共接口选择 / 插件与 Bundle / DSH 安装启动<br/>市场来源与收录 / 项目接入建议 / 模板与接入示例', 'CN', 11, 20),
            Spacer(1, 52),
            p('五项轻量要求 / 按需扩展 / AI 实施与验收', 'CN', 10.5, 19, MUTED),
            Spacer(1, 39),
            p('讨论稿 v0.9  |  2026-10-15', 'CNBold', 10.5, 18, INK),
            PageBreak()]


def parse_markdown(source, styles, compact=False):
    refs = {}
    for label, target in re.findall(r'\[([^\]]+)\]\(([^)]+)\)', source):
        if not target.startswith('#') and target not in refs:
            refs[target] = str(len(refs) + 1).zfill(2)
    inline = Inline(refs)
    lines = source.splitlines()
    story = [] if compact else cover(styles)
    if compact:
        title = next(line[2:] for line in lines if line.startswith('# '))
        story.append(Paragraph(html.escape(title), styles['h2']))
    i, first_section = 0, True
    while i < len(lines):
        line = lines[i]
        if not line.strip() or line.startswith('<!--') or line.startswith('# '):
            i += 1
            continue
        if line == '## 目录':
            story.append(PageBreak())
            title = Paragraph('目录', styles['h2'])
            title._heading = (0, '目录', '目录', False)
            story.append(title)
            story.append(Paragraph('点击条目可跳转到对应页；侧栏书签可展开各章。', styles['body']))
            toc = TableOfContents()
            toc.levelStyles = [styles['toc0'], styles['toc1']]
            toc.dotsMinLevel = 0
            toc.tableStyle = TableStyle([
                ('LEFTPADDING', (0, 0), (-1, -1), 0),
                ('RIGHTPADDING', (0, 0), (-1, -1), 0),
                ('TOPPADDING', (0, 0), (-1, -1), 0.5),
                ('BOTTOMPADDING', (0, 0), (-1, -1), 0.5),
                ('VALIGN', (0, 0), (-1, -1), 'TOP'),
            ])
            story.extend([toc, PageBreak()])
            i += 1
            while i < len(lines) and not lines[i].startswith('## '):
                i += 1
            continue
        heading = re.match(r'^(#{2,4}) (.+)$', line)
        if heading:
            depth, title = len(heading[1]), heading[2]
            if title.startswith('1.1 安装命令'):
                story.append(CondPageBreak(340))
            if depth == 2 and title != '操作指引':
                if title.startswith('1 ') and first_section:
                    first_section = False
                elif title.startswith('附录 '):
                    story.append(PageBreak())
                else:
                    story.extend([CondPageBreak(130 if compact else 280), Spacer(1, 8 if compact else 20)])
            para = Paragraph(inline(title), styles['h'+str(depth)])
            if depth <= 3:
                para._heading = (depth-2, plain(title), slug(title), title != '操作指引')
            story.append(para)
            inline.in_sources = inline.in_sources or title.startswith('附录 D ')
            i += 1
            continue
        if line.startswith('```'):
            language = line[3:].strip()
            block = []
            i += 1
            while i < len(lines) and not lines[i].startswith('```'):
                block.append(lines[i])
                i += 1
            story.append(CodeBlock('\n'.join(block), language))
            i += 1
            continue
        if line.startswith('|'):
            rows = []
            while i < len(lines) and lines[i].startswith('|'):
                cells = [c.strip() for c in lines[i].strip().strip('|').split('|')]
                if not all(re.fullmatch(r':?-{2,}:?', cell) for cell in cells):
                    rows.append(cells)
                i += 1
            if len(set(map(len, rows))) != 1:
                raise ValueError('Inconsistent table at line '+str(i))
            story.append(make_table(rows, inline, styles, compact=compact))
            continue
        if inline.in_sources:
            match = re.match(r'^\*\*\[S(\d+)\]', line)
            if match:
                story.append(Anchor('source-'+match[1]))
        bullet = re.match(r'^(?:- |(\d+)\. )(.+)$', line)
        if bullet:
            marker = bullet[1] + '. ' if bullet[1] else '• '
            story.append(Paragraph(marker + inline(bullet[2]), styles['list']))
            i += 1
            continue
        paragraph = [line]
        i += 1
        while i < len(lines) and lines[i].strip() and not re.match(r'^(#{1,4} |```|\||- |\d+\. )', lines[i]):
            paragraph.append(lines[i])
            i += 1
        text = ' '.join(paragraph)
        para = Paragraph(inline(text), styles['body'])
        if text.startswith('**') and text.endswith('**'):
            following = i
            while following < len(lines) and not lines[following].strip():
                following += 1
            if following < len(lines) and lines[following].startswith('```'):
                end = following + 1
                while end < len(lines) and not lines[end].startswith('```'):
                    end += 1
                line_count = end - following - 1
                minimum = (line_count + 2) * 11.6 + 65 if line_count <= 14 else 130
                story.append(CondPageBreak(minimum))
            else:
                para.keepWithNext = True
        story.append(para)
    return story, refs


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', type=Path, default=HERE / 'README.zh-CN.md')
    parser.add_argument('--output', type=Path, default=ROOT / 'output' / 'pdf' / 'DSH-组件化101与接入SOP.pdf')
    parser.add_argument('--font-dir', type=Path, default=Path('C:/Windows/Fonts'))
    parser.add_argument('--checklist', action='store_true', help='Render the standalone acceptance template without a cover or TOC')
    args = parser.parse_args()
    register_fonts(args.font_dir)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    if args.checklist:
        args.source = HERE / 'acceptance-record.template.zh-CN.md'
        args.output = ROOT / 'output/pdf/DSH-组件化交付验收表.pdf'
    source = args.source.read_text(encoding='utf-8')
    styles = get_styles()
    if args.checklist:
        styles['h2'].fontSize, styles['h2'].leading = 14, 21
        styles['h2'].spaceAfter = 9
        styles['body'].fontSize, styles['body'].leading = 9.3, 14.4
    story, refs = parse_markdown(source, styles, compact=args.checklist)
    doc = ManualDoc(str(args.output), document_title='组件化交付验收表（轻量版）' if args.checklist else 'DSH 组件化接入指南', compact=args.checklist)
    passes = doc.multiBuild(story, maxPasses=8)
    check_path = ROOT / 'tmp' / 'pdfs' / ('checklist-build.json' if args.checklist else 'pdf-build.json')
    check_path.parent.mkdir(parents=True, exist_ok=True)
    check_path.write_text(json.dumps({'passes': passes, 'pages': doc.page,
                                    'headings': doc.heading_records, 'sources': refs}, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'pages': doc.page, 'passes': passes, 'headings': len(doc.heading_records),
                      'sources': len(refs), 'output': str(args.output)}, ensure_ascii=True))


if __name__ == '__main__':
    main()
