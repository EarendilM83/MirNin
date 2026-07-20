const fs = require('fs');
const path = require('path');
const d = require('docx');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, PageBreak,
  Table, TableRow, TableCell, WidthType, BorderStyle, ShadingType, ImageRun,
  Header, Footer, PageNumber, LevelFormat, ExternalHyperlink
} = d;

const SCR = '/home/user/MirNin/docs/ka/screens';
const OUT = '/home/user/MirNin/docs/ka/LMS-sistemis-aghwera-KA.docx';

const FONT = 'Sylfaen';           // Georgian-friendly, ships with Windows
const INK = '1A2230';
const ACCENT = '2A5DB0';
const MUT = '5B6472';
const LINE = 'D5DBE3';
const HEADBG = 'EAF0F8';
const GOODBG = 'E4F5EC';
const WARNBG = 'FBF1D9';
const CRITBG = 'FBE4E5';

// ---------- helpers ----------
function img(file, wpx) {
  const b = fs.readFileSync(path.join(SCR, file));
  const w = b.readUInt32BE(16), h = b.readUInt32BE(20);
  const width = wpx, height = Math.round(wpx * h / w);
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 140, after: 60 },
    children: [ new ImageRun({ type: 'png', data: b, transformation: { width, height },
      border: { color: LINE, space: 1, style: BorderStyle.SINGLE, size: 6 } }) ],
  });
}
function caption(t) {
  return new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 220 },
    children: [ new TextRun({ text: t, italics: true, size: 17, color: MUT, font: FONT }) ] });
}
function h1(t) {
  return new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 300, after: 120 },
    children: [ new TextRun({ text: t, bold: true, size: 30, color: ACCENT, font: FONT }) ] });
}
function h2(t) {
  return new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 200, after: 80 },
    children: [ new TextRun({ text: t, bold: true, size: 23, color: INK, font: FONT }) ] });
}
function p(runs, opts = {}) {
  const arr = Array.isArray(runs) ? runs : [runs];
  return new Paragraph({ spacing: { after: opts.after ?? 120, line: 300 },
    alignment: opts.align || AlignmentType.JUSTIFIED,
    children: arr.map(r => typeof r === 'string'
      ? new TextRun({ text: r, size: 21, color: INK, font: FONT })
      : new TextRun({ font: FONT, size: 21, color: INK, ...r })) });
}
function bullet(runs) {
  const arr = Array.isArray(runs) ? runs : [runs];
  return new Paragraph({ numbering: { reference: 'bl', level: 0 }, spacing: { after: 70, line: 288 },
    children: arr.map(r => typeof r === 'string'
      ? new TextRun({ text: r, size: 21, color: INK, font: FONT })
      : new TextRun({ font: FONT, size: 21, color: INK, ...r })) });
}
// table cell
function cell(text, { w, bg, bold, color, size, align, header } = {}) {
  const runs = (Array.isArray(text) ? text : [text]).map(t =>
    typeof t === 'string'
      ? new TextRun({ text: t, font: FONT, size: size || 18, bold: !!bold, color: color || INK })
      : new TextRun({ font: FONT, size: size || 18, ...t }));
  return new TableCell({
    width: { size: w, type: WidthType.DXA },
    shading: bg ? { type: ShadingType.CLEAR, color: 'auto', fill: bg } : undefined,
    margins: { top: 70, bottom: 70, left: 90, right: 90 },
    children: [ new Paragraph({ alignment: align || AlignmentType.LEFT,
      children: runs }) ],
  });
}
function tblBorders() {
  const s = { style: BorderStyle.SINGLE, size: 4, color: LINE };
  return { top: s, bottom: s, left: s, right: s, insideHorizontal: s, insideVertical: s };
}

// ---------- content ----------
const kids = [];

// Title block
kids.push(new Paragraph({ alignment: AlignmentType.LEFT, spacing: { before: 200, after: 0 },
  children: [ new TextRun({ text: 'EduCore LMS', bold: true, size: 26, color: ACCENT, font: FONT }) ] }));
kids.push(new Paragraph({ spacing: { after: 40 }, border: { bottom: { style: BorderStyle.SINGLE, size: 10, color: ACCENT, space: 6 } },
  children: [ new TextRun({ text: 'სასწავლო პროცესის მართვის სისტემა', bold: true, size: 44, color: INK, font: FONT }) ] }));
kids.push(new Paragraph({ spacing: { before: 120, after: 30 },
  children: [ new TextRun({ text: 'სისტემის აღწერა და ფუნქციონალი', size: 26, color: INK, font: FONT }) ] }));
kids.push(new Paragraph({ spacing: { after: 200 },
  children: [ new TextRun({ text: 'მომხმარებლის როლები · შეფასების მოდელები · აპლიკაციები · აკადემიური კეთილსინდისიერების კონტროლი',
    size: 19, color: MUT, italics: true, font: FONT }) ] }));

// Meta table
kids.push(new Table({
  width: { size: 9300, type: WidthType.DXA }, columnWidths: [2400, 6900], borders: tblBorders(),
  rows: [
    ['დოკუმენტის ტიპი', 'სისტემის აღწერა (ფუნქციური დოკუმენტაცია)'],
    ['ენა', 'ქართული'],
    ['ვერსია', '1.0'],
    ['თარიღი', '2026 წელი'],
    ['სტატუსი', 'სამუშაო / შიდა გამოყენებისთვის'],
  ].map(([k, v]) => new TableRow({ children: [
    cell(k, { w: 2400, bg: HEADBG, bold: true, size: 18 }),
    cell(v, { w: 6900, size: 18 }),
  ] })),
}));

// 1. Overview
kids.push(h1('1. სისტემის მიმოხილვა'));
kids.push(p('EduCore LMS არის სასწავლო პროცესის მართვის ერთიანი პლატფორმა, რომელიც სრულად ფარავს სწავლების ციკლს — პროგრამის დაგეგმვიდან და კურსების აწყობიდან დაწყებული, სტუდენტის ყოველდღიური სწავლითა და შეფასებით დამთავრებული. სისტემა აერთიანებს ადმინისტრირებას, სწავლებას, შეფასებასა და ანალიტიკას ერთ სივრცეში, სადაც ყველა მონაცემი დაკავშირებულია და თანმიმდევრულია.'));
kids.push(p('პლატფორმა შედგება სამი ურთიერთდაკავშირებული კომპონენტისგან:'));
kids.push(bullet([{ text: 'ვებ-აპლიკაცია (ადმინისტრირება) — ', bold: true }, { text: 'მართვის ცენტრალური სივრცე. აქ იმართება მთელი სისტემა: პროგრამები, კურსები, შეფასების მოდელები, მომხმარებლები და როლები, ანგარიშგება. განკუთვნილია ადმინისტრაციისთვის.' }]));
kids.push(bullet([{ text: 'მასწავლებლის აპლიკაცია — ', bold: true }, { text: 'ლექტორის სამუშაო გარემო: სასწავლო მასალა, დასწრება, დავალებები, ქვიზების შექმნა და ელექტრონული ჟურნალი.' }]));
kids.push(bullet([{ text: 'სტუდენტის აპლიკაცია — ', bold: true }, { text: 'მობილური აპლიკაცია, რომელიც სწავლას თამაშისებურ, ინტერაქტიულ პროცესად აქცევს — Duolingo-ს მსგავსი მიდგომით (გაკვეთილების „გზა", დღიური სერია, ქულები, ბეიჯები).' }]));
kids.push(p([{ text: 'ცენტრალური პრინციპი: ', bold: true }, { text: 'ადმინისტრაცია სისტემას მართავს ვებ-აპლიკაციით, ხოლო მასწავლებელი და სტუდენტი ურთიერთობენ თავიანთ სპეციალიზებულ აპლიკაციებთან. სამივე მხარე მუშაობს ერთ საერთო მონაცემთა ბაზაზე რეალურ დროში.' }]));
kids.push(img('s1.png', 600));
kids.push(caption('სურ. 1. ვებ-აპლიკაციის მთავარი პანელი — პროგრამების, სტუდენტების და მოსწრების მიმოხილვა'));

// 2. Architecture / apps
kids.push(h1('2. სისტემის არქიტექტურა და აპლიკაციები'));
kids.push(p('სამივე აპლიკაცია ერთ სისტემას წარმოადგენს, თუმცა თითოეული მორგებულია კონკრეტული მომხმარებლის საჭიროებაზე. ცხრილში მოცემულია მათი დანიშნულება:'));
{
  const rows = [
    ['კომპონენტი', 'მომხმარებელი', 'ძირითადი ფუნქციები', 'პლატფორმა'],
    ['ვებ-აპლიკაცია (ადმინ.)', 'ადმინისტრაცია', 'პროგრამების, კურსების, შეფასების მოდელების, მომხმარებლების და ანგარიშების მართვა', 'ვები (ბრაუზერი)'],
    ['მასწავლებლის აპლიკაცია', 'მასწავლებელი / ლექტორი', 'მასალა, დასწრება, დავალებები, ქვიზები, ელ. ჟურნალი', 'ვები / მობილური'],
    ['სტუდენტის აპლიკაცია', 'სტუდენტი', 'გაკვეთილები, სავარჯიშოები, ონლაინ შეფასება, პროგრესი, მოტივაცია', 'მობილური (iOS / Android)'],
  ];
  const cw = [1900, 1700, 4000, 1700];
  kids.push(new Table({ width: { size: 9300, type: WidthType.DXA }, columnWidths: cw, borders: tblBorders(),
    rows: rows.map((r, i) => new TableRow({ tableHeader: i === 0, children: r.map((c, j) =>
      cell(c, { w: cw[j], bg: i === 0 ? ACCENT : (i % 2 ? undefined : HEADBG),
        bold: i === 0, color: i === 0 ? 'FFFFFF' : INK, size: 17 })) })) }));
}

// 3. Roles & permissions
kids.push(new Paragraph({ children: [ new PageBreak() ] }));
kids.push(h1('3. მომხმარებლის როლები და უფლებამოსილებები'));
kids.push(p('სისტემაში განსაზღვრულია შვიდი სისტემური როლი. თითოეულ როლს აქვს მკაცრად შემოსაზღვრული უფლებამოსილება — მომხმარებელი ხედავს და მართავს მხოლოდ იმას, რაც მის ფუნქციას შეესაბამება. ეს უზრუნველყოფს მონაცემთა უსაფრთხოებას და პასუხისმგებლობის მკაფიო გამიჯვნას.'));

const roles = [
  ['პროგრამების ხელმძღვანელი', 'სისტემის უმაღლესი დონის მართვა. სრული წვდომა ყველა პროგრამაზე, შეფასების მოდელზე, კატეგორიაზე, მომხმარებელსა და ანგარიშზე. ქმნის და აქცევს პროგრამებს, ანიჭებს როლებს და განსაზღვრავს გლობალურ პარამეტრებს.'],
  ['ხარისხის კონტროლი', 'ზედამხედველობს სასწავლო და შეფასების ხარისხს ყველა პროგრამაზე. აქვს სანახავი (read/audit) წვდომა მოსწრებაზე, შეფასების მოდელებსა და ჟურნალებზე, ამზადებს ანალიტიკურ ანგარიშებს. ვერ ცვლის ნიშნებს, მაგრამ აღნიშნავს (flag) გადასამოწმებელ შემთხვევებს.'],
  ['პროგრამის კოორდინატორი', 'მართავს მისთვის მინიჭებულ პროგრამა(ებ)ს: ჯგუფები, განრიგი, ჩარიცხვა, მასწავლებლების მიბმა კურსებზე, მიმდინარეობის მონიტორინგი. ხედავს მხოლოდ საკუთარი პროგრამის მონაცემებს.'],
  ['მასწავლებელი', 'მართავს საკუთარ კურსებს: სასწავლო მასალა, დავალებები, ქვიზები, დასწრება და ნიშნების დაწერა ელ. ჟურნალში. ვერ ცვლის შეფასების მოდელს ან სხვისი კურსის მონაცემებს.'],
  ['პროგრამის ხელმძღვანელი', 'კონკრეტული პროგრამის აკადემიური ხელმძღვანელი. ამტკიცებს სილაბუსებსა და შეფასების მოდელს თავისი პროგრამისთვის, ზედამხედველობს მასწავლებლებსა და შედეგებს. (განსხვავდება „პროგრამების ხელმძღვანელისგან", რომელიც ყველა პროგრამას მართავს.)'],
  ['კარიერული კოორდინატორი', 'წვდომა სტუდენტების პროგრესზე, კომპეტენციებსა და კარიერულ მოდულებზე (სტაჟირება, დასაქმება). მუშაობს კურსდამთავრებულთა და დამსაქმებელთა მიმართულებით.'],
  ['HR', 'ადამიანური რესურსების მართვა: პერსონალისა და მასწავლებელთა ჩანაწერები, ხელშეკრულებები, დატვირთვა და ონბორდინგი. წვდომა შეზღუდულია HR-მონაცემებით.'],
];
roles.forEach((r) => kids.push(new Paragraph({
  numbering: { reference: 'nm', level: 0 }, spacing: { after: 90, line: 288 },
  children: [ new TextRun({ text: r[0] + ' — ', bold: true, color: ACCENT, size: 21, font: FONT }),
    new TextRun({ text: r[1], size: 21, color: INK, font: FONT }) ] })));

kids.push(p([{ text: 'უფლებამოსილებების მატრიცა. ', bold: true }, { text: 'ქვემოთ მოცემულია ძირითადი უფლებების განაწილება როლების მიხედვით (სრული / ნახვა / შეზღუდული / დახურული):' }], { after: 60 }));
{
  const head = ['როლი', 'პროგრ. მართვა', 'შეფ. მოდელი', 'ნიშნის დაწერა', 'მომხმარებ.', 'ანგარიშები'];
  const data = [
    ['პროგრამების ხელმძღვანელი', 'სრული', 'სრული', 'რედაქტ.', 'სრული', 'სრული'],
    ['ხარისხის კონტროლი', 'ნახვა', 'ნახვა', 'აუდიტი', 'ნახვა', 'სრული'],
    ['პროგრამის კოორდინატორი', 'თავისი', 'ნახვა', 'კონტროლი', 'თავისი', 'თავისი'],
    ['პროგრამის ხელმძღვანელი', 'თავისი', 'დამტკიცება', 'ნახვა', 'ნახვა', 'თავისი'],
    ['მასწავლებელი', '—', '—', 'თავისი კურსი', '—', 'თავისი'],
    ['კარიერული კოორდინატორი', '—', '—', '—', 'ნახვა', 'კარიერა'],
    ['HR', '—', '—', '—', 'პერსონალი', 'HR'],
  ];
  const cw = [2600, 1340, 1340, 1500, 1260, 1260];
  const rows = [ new TableRow({ tableHeader: true, children: head.map((h, j) =>
    cell(h, { w: cw[j], bg: ACCENT, bold: true, color: 'FFFFFF', size: 16, align: j ? AlignmentType.CENTER : AlignmentType.LEFT })) }) ];
  data.forEach((r, i) => rows.push(new TableRow({ children: r.map((c, j) => {
    let bg = i % 2 ? undefined : 'F4F7FB';
    if (j > 0) { if (c === 'სრული') bg = GOODBG; else if (c === '—') bg = CRITBG; else bg = WARNBG; }
    return cell(c, { w: cw[j], bg, bold: j === 0, size: 16, align: j ? AlignmentType.CENTER : AlignmentType.LEFT });
  }) })));
  kids.push(new Table({ width: { size: 9300, type: WidthType.DXA }, columnWidths: cw, borders: tblBorders(), rows }));
}
kids.push(p([{ text: '🔒 ', }, { text: 'ყველა მნიშვნელოვანი მოქმედება აღირიცხება აუდიტის ჟურნალში — ვინ, რა და როდის შეასრულა.', size: 18, color: MUT, italics: true }], { after: 100 }));
kids.push(img('s3.png', 600));
kids.push(caption('სურ. 2. როლებისა და უფლებამოსილებების მართვის ეკრანი (წვდომის მატრიცა)'));

// 4. Evaluation (MAIN ACCENT)
kids.push(new Paragraph({ children: [ new PageBreak() ] }));
kids.push(h1('4. შეფასების პროცესი და მოდელები'));
kids.push(p('შეფასება სისტემის ცენტრალური ნაწილია. მისი აგება მოქნილი და თანმიმდევრულია — ერთხელ განსაზღვრული წესები ავტომატურად მოქმედებს მთელ პროგრამაზე და ყველა კურსზე, რაც გამორიცხავს ხელით შეცდომებსა და სუბიექტურობას.'));

kids.push(h2('4.1. სტრუქტურა: პროგრამა → კურსი → მოდელი → კატეგორია'));
kids.push(p('შეფასების ლოგიკა აგებულია იერარქიულად:'));
kids.push(bullet([{ text: 'პროგრამა ', bold: true }, { text: 'აერთიანებს რამდენიმე კურსს (მაგ. „ვებ-პროგრამირება" → HTML/CSS, JavaScript, ბაზები, პროექტი).' }]));
kids.push(bullet([{ text: 'თითოეულ კურსს ', bold: true }, { text: 'მიბმული აქვს შეფასების მოდელი — წესების ნაკრები, რომლითაც გამოითვლება საბოლოო ნიშანი.' }]));
kids.push(bullet([{ text: 'მოდელი ', bold: true }, { text: 'შედგება კატეგორიებისგან (კომპონენტებისგან), თითოეულს აქვს თავისი წონა ქულებში.' }]));
kids.push(bullet([{ text: 'მოდელი მრავალჯერ გამოსაყენებელია — ', bold: true }, { text: 'ერთი მოდელი შეიძლება მიება რამდენიმე კურსს ან პროგრამას (შაბლონის პრინციპი).' }]));

kids.push(h2('4.2. შეფასების მოდელი და კატეგორიები'));
kids.push(p('მოდელი განსაზღვრავს, რისგან შედგება საბოლოო 100 ქულა. თითოეული კატეგორია არის ცალკე შემფასებელი კომპონენტი განსაზღვრული წონით. ცხრილში მოცემულია მოდელის „სტანდარტული 100" მაგალითი:'));
{
  const head = ['კატეგორია', 'ტიპი', 'წონა (ქულა)', 'მინ. ბარიერი'];
  const data = [
    ['აქტივობა და დასწრება', 'უწყვეტი', '10', '—'],
    ['ქვიზები (ონლაინ)', 'ავტომატური', '20', '50%'],
    ['პრაქტიკული დავალებები', 'ხელით', '20', '—'],
    ['შუალედური გამოცდა', 'ონლაინ, მეთვალყურეობით', '20', '50%'],
    ['დასკვნითი გამოცდა', 'ონლაინ, მეთვალყურეობით', '30', '60%'],
    ['სულ', '', '100', ''],
  ];
  const cw = [3100, 3200, 1600, 1400];
  const rows = [ new TableRow({ tableHeader: true, children: head.map((h, j) =>
    cell(h, { w: cw[j], bg: ACCENT, bold: true, color: 'FFFFFF', size: 17, align: j > 1 ? AlignmentType.CENTER : AlignmentType.LEFT })) }) ];
  data.forEach((r, i) => { const last = i === data.length - 1;
    rows.push(new TableRow({ children: r.map((c, j) =>
      cell(c, { w: cw[j], bg: last ? HEADBG : (i % 2 ? undefined : 'F4F7FB'), bold: last || j === 0, size: 17,
        align: j > 1 ? AlignmentType.CENTER : AlignmentType.LEFT })) })); });
  kids.push(new Table({ width: { size: 9300, type: WidthType.DXA }, columnWidths: cw, borders: tblBorders(), rows }));
}
kids.push(p([{ text: 'წონების ჯამი ყოველთვის უნდა უდრიდეს 100-ს — ', italics: false }, { text: 'სისტემა ამას რეალურ დროში ამოწმებს და არ ინახავს არასრულ მოდელს.' }], { after: 120 }));
kids.push(img('s2.png', 600));
kids.push(caption('სურ. 3. შეფასების მოდელის რედაქტორი — კატეგორიები, წონები, ბარიერები და ECTS შკალა'));

kids.push(h2('4.3. ბარიერები, ჩათვლის პირობა და შკალა'));
kids.push(bullet([{ text: 'მინიმალური ბარიერი — ', bold: true }, { text: 'ცალკეულ კომპონენტს (მაგ. დასკვნითი გამოცდა) შეიძლება ჰქონდეს ზღვარი, რომლის ქვემოთაც კურსი ვერ ითვლება, ჯამური ქულის მიუხედავად.' }]));
kids.push(bullet([{ text: 'ჩათვლის პირობა — ', bold: true }, { text: 'დადებითი შედეგისთვის საჭიროა ≥ 51 ქულა, დასკვნითის ≥ 60% და დასწრების ≥ 75%.' }]));
kids.push(bullet([{ text: 'ECTS შკალა — ', bold: true }, { text: 'ქულა ავტომატურად გადადის ასოით შეფასებაში: A (91–100), B (81–90), C (71–80), D (61–70), E (51–60), F/FX (≤ 50).' }]));
kids.push(bullet([{ text: 'ავტომატური დათვლა — ', bold: true }, { text: 'როგორც კი მასწავლებელი ან სისტემა შეიტანს კომპონენტის ქულას, საბოლოო შედეგი წონების მიხედვით მყისვე გადაითვლება. ხელით შესწორება აღინიშნება და საჭიროებს კომენტარს — გამჭვირვალობისთვის.' }]));

// 5. Teacher side
kids.push(new Paragraph({ children: [ new PageBreak() ] }));
kids.push(h1('5. მასწავლებლის მხარე'));
kids.push(p('მასწავლებელი მუშაობს საკუთარ აპლიკაციაში, რომელიც აერთიანებს სწავლებისთვის საჭირო ყველა ინსტრუმენტს. მასწავლებელი ხედავს მხოლოდ თავის კურსებსა და სტუდენტებს.'));
kids.push(bullet([{ text: 'ჩემი კურსები და განრიგი — ', bold: true }, { text: 'მინიჭებული ჯგუფები, გაკვეთილების გრაფიკი და სასწავლო მასალა.' }]));
kids.push(bullet([{ text: 'დასწრება — ', bold: true }, { text: 'დასწრების ერთ შეხებით მონიშვნა, რაც პირდაპირ იკვებება შეფასების „დასწრების" კომპონენტში.' }]));
kids.push(bullet([{ text: 'დავალებები და ქვიზები — ', bold: true }, { text: 'დავალებების გამოცხადება, ონლაინ ქვიზების შექმნა (კითხვების ბანკი, დროის ლიმიტი, მეთვალყურეობის რეჟიმი).' }]));
kids.push(bullet([{ text: 'ელექტრონული ჟურნალი — ', bold: true }, { text: 'ნიშნების შეტანა; წონები და საბოლოო ქულა ავტომატურად ითვლება მიბმული მოდელით.' }]));
kids.push(img('s4.png', 600));
kids.push(caption('სურ. 4. მასწავლებლის აპლიკაცია — ელექტრონული ჟურნალი და ავტომატური დათვლა'));

// 6. Student side
kids.push(h1('6. სტუდენტის მხარე'));
kids.push(p('სტუდენტის მობილური აპლიკაცია სწავლას მიმზიდველ, ინტერაქტიულ და მოტივირებულ პროცესად აქცევს — მიდგომით, რომელიც Duolingo-ს მსგავსია. მასალა დაყოფილია მოკლე, თანმიმდევრულ გაკვეთილებად, რომლებსაც სტუდენტი „გზის" გასწვრივ გადის.'));
kids.push(bullet([{ text: 'გაკვეთილების გზა — ', bold: true }, { text: 'თანმიმდევრული ბიჯები; მომდევნო ეტაპი იხსნება წინის დასრულების შემდეგ.' }]));
kids.push(bullet([{ text: 'ინტერაქტიული სავარჯიშოები — ', bold: true }, { text: 'მოკლე კითხვები დაუყოვნებელი უკუკავშირით, „სიცოცხლეებით" და ქულებით.' }]));
kids.push(bullet([{ text: 'მოტივაცია — ', bold: true }, { text: 'დღიური სერია (streak), ქულები (XP), ბეიჯები და პროგრესის ინდიკატორები, რაც სწავლის რეგულარულობას წაახალისებს.' }]));
kids.push(bullet([{ text: 'პროფილი და შეფასებები — ', bold: true }, { text: 'პირადი მოსწრება, კურსის პროგრესი და მომდევნო ონლაინ შეფასებების განრიგი.' }]));
kids.push(img('s5.png', 600));
kids.push(caption('სურ. 5. სტუდენტის აპლიკაცია — გაკვეთილების გზა, ინტერაქტიული სავარჯიშო და პროფილი'));

// 7. Anti-cheat
kids.push(new Paragraph({ children: [ new PageBreak() ] }));
kids.push(h1('7. ონლაინ შეფასება და აკადემიური კეთილსინდისიერების კონტროლი'));
kids.push(p('ონლაინ ქვიზისა და გამოცდის დროს სისტემა უზრუნველყოფს შეფასების სანდოობას — ის აქტიურად აღიკვეთს და აღრიცხავს არაკეთილსინდისიერ ქცევას. კონტროლი მუშაობს ორივე პლატფორმაზე: ვებზე ბრაუზერის ჩაშენებული ფუნქციებით, ხოლო მობილურზე — აპლიკაციის დონეზე.'));

kids.push(h2('7.1. დაცული რეჟიმი და ჩანართის გადართვის აღკვეთა'));
kids.push(bullet([{ text: 'დაცული რეჟიმი (Lockdown) — ', bold: true }, { text: 'შეფასების დაწყებისთანავე ეკრანი გადადის სრულეკრან რეჟიმში; სხვა ჩანართზე ან ფანჯარაზე გადართვა და გამოსვლა შეზღუდულია.' }]));
kids.push(bullet([{ text: 'ფოკუსის დაკარგვის დეტექცია — ', bold: true }, { text: 'თუ სტუდენტი გამოვა ფანჯრიდან ან სცადოს სხვა ჩანართზე გადასვლა, სისტემა მყისვე აფიქსირებს მოვლენას, აჩვენებს გაფრთხილებას და უგზავნის მეთვალყურეს. გაფრთხილებები ითვლება (მაგ. 1/3, 2/3).' }]));
kids.push(bullet([{ text: 'ავტომატური დახურვა — ', bold: true }, { text: 'დარღვევის ზღვრის (მაგ. 3-ის) გადაცილებისას ქვიზი ავტომატურად იხურება და შედეგი აღინიშნება გადასამოწმებლად.' }]));

kids.push(h2('7.2. მოწყობილობის მონიტორინგი'));
kids.push(bullet([{ text: 'მობილური მოწყობილობის აღრიცხვა — ', bold: true }, { text: 'სტუდენტის აპლიკაცია აკონტროლებს მოწყობილობას და აფიქსირებს, თუ სტუდენტი შეფასების მიმდინარეობისას იყენებს ტელეფონს სხვა მიზნით (სხვა აპში გადასვლა, ეკრანის ჩაწერა).' }]));
kids.push(bullet([{ text: 'ვები vs. მობილური — ', bold: true }, { text: 'ვებ-ვერსია დარღვევებს აფიქსირებს ბრაუზერის ჩაშენებული ფუნქციებით (სრულეკრანი, ფოკუსის/ხილვადობის მოვლენები); მობილურ ვერსიაში კი ამას აპლიკაცია უზრუნველყოფს.' }]));
kids.push(bullet([{ text: 'იდენტიფიკაცია — ', bold: true }, { text: 'შეფასების დაწყებამდე ხდება მონაწილის იდენტიფიკაცია; მიმდინარეობისას შესაძლებელია კამერისა და მიკროფონის ჩართვა.' }]));
kids.push(img('s6.png', 605));
kids.push(caption('სურ. 6. ონლაინ ქვიზი დაცულ რეჟიმში — ჩანართის გადართვის აღმოჩენა და გაფრთხილება'));

kids.push(h2('7.3. მეთვალყურეობის პანელი'));
kids.push(p('ადმინისტრაცია და მასწავლებელი რეალურ დროში ხედავენ ყველა მონაწილის სტატუსსა და მოვლენების ცოცხალ ჟურნალს: ვინ გადავიდა სხვა ჩანართზე, რომელი მოწყობილობიდან, რა დროს — და რა რეაქცია მოჰყვა ამას სისტემისგან.'));
kids.push(img('s7.png', 600));
kids.push(caption('სურ. 7. მეთვალყურეობის პანელი — მოვლენების ცოცხალი ჟურნალი და დარღვევების აღრიცხვა'));

// 8. Conclusion
kids.push(h1('8. შემაჯამებელი'));
kids.push(p('EduCore LMS აერთიანებს ადმინისტრირებას, სწავლებას, შეფასებასა და აკადემიური კეთილსინდისიერების კონტროლს ერთ თანმიმდევრულ სისტემაში. მკაფიოდ გამიჯნული როლები უზრუნველყოფს უსაფრთხოებას და პასუხისმგებლობის განაწილებას; მოქნილი შეფასების მოდელები — ობიექტურ და ავტომატიზებულ შეფასებას; ხოლო სპეციალიზებული აპლიკაციები მასწავლებელსა და სტუდენტს სთავაზობს მათზე მორგებულ, თანამედროვე გამოცდილებას. ონლაინ შეფასების დაცული რეჟიმი კი უზრუნველყოფს შედეგების სანდოობას როგორც ვებ-, ისე მობილურ პლატფორმაზე.'));

// ---------- document ----------
const doc = new Document({
  creator: 'EduCore LMS',
  title: 'LMS სისტემის აღწერა',
  numbering: { config: [
    { reference: 'bl', levels: [
      { level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT,
        style: { paragraph: { indent: { left: 420, hanging: 240 } }, run: { font: FONT } } } ] },
    { reference: 'nm', levels: [
      { level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT,
        style: { paragraph: { indent: { left: 460, hanging: 300 } }, run: { bold: true, color: ACCENT, font: FONT } } } ] },
  ] },
  styles: { default: { document: { run: { font: FONT, size: 21, color: INK } } } },
  sections: [ {
    properties: { page: { margin: { top: 1000, bottom: 1000, left: 1100, right: 1100 } } },
    headers: { default: new Header({ children: [ new Paragraph({
      alignment: AlignmentType.RIGHT, border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: LINE, space: 4 } },
      children: [ new TextRun({ text: 'EduCore LMS · სისტემის აღწერა', size: 15, color: MUT, font: FONT }) ] }) ] }) },
    footers: { default: new Footer({ children: [ new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [ new TextRun({ text: 'გვ. ', size: 15, color: MUT, font: FONT }),
        new TextRun({ children: [ PageNumber.CURRENT ], size: 15, color: MUT, font: FONT }) ] }) ] }) },
    children: kids,
  } ],
});

Packer.toBuffer(doc).then(buf => { fs.writeFileSync(OUT, buf); console.log('WROTE', OUT, buf.length, 'bytes'); });
