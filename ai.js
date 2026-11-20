// Cloudflare Pages Function: POST /api/ai
//
// Answers in "تكنوتج لتجارة المعادن" with Workers AI (free daily allowance):
//   kind "ask"     the shipment assistant (question + recent turns + data)
//   kind "month"   the monthly summary
//   kind "msg"     a short WhatsApp message to a customer (only customer-safe fields are used)
//   kind "explain" a plain explanation of one shipment's result (internal)
//   kind "inv"     reads the text found in a tax invoice (sale or purchase) and returns its fields as JSON
//   kind "invimg"  reads a photo of a tax invoice with a vision model and returns its fields as JSON
// The app sends the question and the data; the instructions and the model name are kept here,
// so the browser sends no AI key for these features. "lang": "en" answers in English, otherwise Arabic.
//
// Setup, once, in the Cloudflare dashboard: open the Pages project, go to
// Settings → Bindings → Add → Workers AI, set the variable name to AI, then redeploy.

const MODEL = '@cf/qwen/qwen3-30b-a3b-fp8';
const MAX_BODY_BYTES = 200 * 1024; // the whole request
const MAX_IMG_BODY = 1600 * 1024;  // an invoice photo (the app sends it at most 1,400 px, JPEG)
const VISION_MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct';
const MAX_DATA_CHARS = 48000;      // the data JSON (the app keeps it under 36,000)
const MAX_QUESTION = 1000;         // characters in one question
const MAX_HISTORY = 6;             // earlier messages sent along
const MAX_TURN = 1000;             // characters kept from each earlier message
const MAX_TOKENS = 1500;           // room for the answer
const MAX_TOKENS_SHORT = 800;      // customer message and shipment explanation
const NO_THINK = ' /no_think';     // Qwen3 switch: answer directly, without a hidden thinking step first

const ASK_SYS = 'أنت مساعد داخل تطبيق "تكنوتج لتجارة المعادن" لإدارة شحنات المعادن (ألمنيوم ونحاس وزنك وغيرها): ما اشتريناه ومن أي مورد، وما بعناه لأي عميل، والمصاريف والأرباح.\n' +
  'أجب بالعربية بإيجاز ووضوح، والأرقام من البيانات المرفقة فقط. لا تخترع رقماً أو عميلاً أو شحنة. إذا لم تكن الإجابة في البيانات فقل ذلك بصراحة.\n' +
  'المبالغ بالعملة المذكورة في currency. ربح الشحنة = المبيعات − المشتريات − المصاريف. الشحنة التي لم تُبع بعد مبيعاتها صفر، فربحها سالب (تكلفة حتى الآن)، وهكذا يحسبه التقرير الشهري في التطبيق. وضّح ذلك إذا أثّر على الجواب.\n' +
  'الحقول totals وmonthly وbyCustomer وbySupplier وbyProduct تشمل كل الشحنات، أما recentShipments فهي آخر الشحنات فقط. استعمل الإجماليات للأسئلة عن فترات طويلة.\n' +
  'لا تستعمل Markdown: لا نجوم ولا # ولا جداول. اكتب نصاً عادياً، وإن احتجت قائمة فاستعمل شرطة بسيطة في بداية السطر.';

const ASK_SYS_EN = 'You are an assistant inside the app "Technotouch Metals Trading", which manages metal shipments (aluminium, copper, zinc and others): what was bought and from which supplier, what was sold to which customer, and the costs and profits.\n' +
  'Answer in English, briefly and clearly. Use only the numbers in the attached data. Do not invent any number, customer or shipment. If the answer is not in the data, say so plainly.\n' +
  'Amounts are in the currency named in currency. Shipment profit = sales − purchases − costs. A shipment whose sales are not yet recorded has zero sales, so its profit is negative (the cost so far), the same way the app\'s monthly report counts it. Say so when it changes the answer.\n' +
  'The fields totals, monthly, byCustomer, bySupplier and byProduct cover all shipments, while recentShipments are only the latest shipments. Use the totals for questions about long periods. Keep names exactly as written in the data.\n' +
  'Do not use Markdown: no asterisks, no # and no tables. Write plain text; if you need a list, use a simple dash at the start of a line.';

const MONTH_SYS = 'أنت محلل مالي لشركة تجارة معادن. اكتب تقرير الشهر للمالك بالعربية، اعتماداً على البيانات المرفقة فقط ولا تخترع أي رقم.\n' +
  'الترتيب: أولاً الأرقام الأساسية (عدد الشحنات، الطن، المشتريات، المبيعات، المصاريف، الربح، وعدد الشحنات غير المباعة). ' +
  'ثم أبرز ما حدث: أفضل عميل وأفضل مورد وأفضل صنف، وأي شحنة خاسرة أو مصروف غير عادي. ' +
  'ثم المخاطر: الشحنات غير المباعة وقيمة تكلفتها، وأي اعتماد مفرط على عميل أو مورد واحد. ' +
  'وأخيراً توصيتان أو ثلاث قصيرة وعملية.\n' +
  'لا تستعمل Markdown: لا نجوم ولا # ولا جداول، واكتب عناوين قصيرة في سطر مستقل. لا تتجاوز 250 كلمة.';

const MONTH_SYS_EN = 'You are a financial analyst for a metals trading company. Write the owner\'s report for the month in English, based only on the attached data. Do not invent any number.\n' +
  'Order: first the key figures (number of shipments, tons, purchases, sales, costs, profit, and the number of unsold shipments). ' +
  'Then what happened: the best customer, the best supplier, the best product, and any losing shipment or unusual cost. ' +
  'Then the risks: unsold shipments and their cost, and any heavy dependence on one customer or supplier. ' +
  'Finally two or three short, practical recommendations.\n' +
  'Do not use Markdown: no asterisks, no # and no tables. Write short headings on their own lines. Do not exceed 250 words.';

const MSG_SYS = 'أنت تكتب رسالة واتساب قصيرة ومهذبة من شركة "تكنوتج لتجارة المعادن" إلى عميلها عن شحنة معادن.\n' +
  'استعمل الحقائق المرفقة فقط (اسم العميل والتاريخ والأصناف والأطنان والمبلغ إن وُجد)، ولا تخترع أي رقم أو تاريخ أو اسم.\n' +
  'ممنوع ذكر التكلفة أو الربح أو المورّد أو أي معلومة داخلية، فالرسالة للعميل.\n' +
  'اكتب الرسالة فقط بدون مقدمة أو شرح، من 3 إلى 6 أسطر، وابدأ بتحية قصيرة باسم العميل إن وُجد. لا تستعمل Markdown.';

const MSG_SYS_EN = 'You write a short, polite WhatsApp message from the company "Technotouch Metals Trading" to its customer about a metal shipment.\n' +
  'Use only the facts attached (customer name, date, items, tons and the amount if any). Do not invent any number, date or name.\n' +
  'Never mention cost, profit, the supplier or any internal information: the message is for the customer.\n' +
  'Write only the message, with no introduction or explanation, in 3 to 6 short lines, starting with a brief greeting that uses the customer\'s name if one is given. Do not use Markdown.';

const EXPLAIN_SYS = 'أنت تشرح لمالك شركة "تكنوتج لتجارة المعادن" نتيجة شحنة واحدة بكلمات بسيطة.\n' +
  'الربح = المبيعات − المشتريات − المصاريف. إذا كانت الشحنة لم تُبع بعد فمبيعاتها صفر، وربحها السالب يمثل التكلفة حتى الآن. الهامش = الربح ÷ المبيعات، وهو null إذا لم تُسجَّل مبيعات.\n' +
  'اعتمد على الأرقام المرفقة فقط، ولا تحسب أرقاماً جديدة. اكتب في 3 إلى 5 جمل قصيرة: هل الشحنة رابحة أم خاسرة ولماذا، وما الذي أثّر أكثر على النتيجة، وما الخطوة التالية المقترحة إن وُجدت.\n' +
  'لا تستعمل Markdown ولا جداول. اكتب بالعربية.';

const EXPLAIN_SYS_EN = 'You explain to the owner of "Technotouch Metals Trading" the result of one shipment in plain words.\n' +
  'Profit = sales − purchases − costs. If the shipment is not sold yet, its sales are zero and its negative profit is the cost so far. The margin = profit ÷ sales, and it is null when no sales are recorded.\n' +
  'Use only the attached numbers and do not calculate new ones. Write 3 to 5 short sentences: whether the shipment made or lost money and why, what affected the result most, and the next step if there is one.\n' +
  'Do not use Markdown and no tables. Write in English.';

// Invoice reading: the app sends the text it found in the file (PDF text or OCR), never the file itself.
function invSys(d) {
  const buy = d.side === 'buy';
  return 'You read the text of a Gulf (GCC) tax invoice. The text was extracted from a PDF or a photo, so it can contain OCR mistakes, broken lines and missing Arabic words.\n' +
    'Our company is "' + d.ownName + '"' + (d.ownTrn ? ' with TRN ' + d.ownTrn : '') + '.\n' +
    (buy
      ? 'This is a PURCHASE invoice: a supplier issued it and our company is the buyer. "party" is the SELLER who issued the invoice (its name is usually at the top or under From/Seller), never our company.\n'
      : 'This is a SALES invoice issued by our company. "party" is the CUSTOMER being billed (Bill To / Customer / المشتري), never our company.\n') +
    'Reply with ONLY one JSON object, no other text, with exactly these keys:\n' +
    '- no: the invoice number as printed (string).\n' +
    '- date: the invoice date as YYYY-MM-DD. Gulf dates are day/month/year (03/04/2026 means 3 April 2026).\n' +
    '- party: the name of the other party as described above.\n' +
    '- trn: the tax registration number of that party (TRN / VAT number: 15 digits in UAE, Saudi Arabia and Bahrain; OM plus 10 digits in Oman), without spaces' + (d.ownTrn ? ', never ' + d.ownTrn : '') + '.\n' +
    '- net: total taxable amount before VAT (number). - vat: total VAT (number, 0 if none). - total: grand total including VAT (number).\n' +
    '- cur: AED, SAR, QAR, BHD, OMR, KWD or USD. - taxMode: "rate" if VAT is charged, "zero" if 0%, "reverse" if the invoice says reverse charge.\n' +
    'Copy numbers exactly as printed, without thousands separators, with a dot for decimals. Use null for anything that is not in the text. Do not guess.';
}
// Commercial quotation: the user describes it in Arabic or English, often as short lines "item price".
function quoteSys(q) {
  return 'You write professional English commercial quotations for ' + (q.co || 'our company') + ' (a metals trader). Today is ' + (q.today || '') + '.\n' +
    'The request may be in Arabic or English, may have spelling mistakes (for example "Aluminim" means Aluminium, "لشكره" or "لشركه" means "for the company") and may list items one per line as "item name price".\n' +
    'Reply with ONLY one JSON object, no other text: {"to": customer company name or "", "subject": string, "intro": string, ' +
    '"items": [{"material": string, "spec": string, "mech": price or pricing mechanism, "inc": incoterm and place or "", "load": load size or ""}], ' +
    '"terms": [{"t": short title, "x": text}], "closing": string}.\n' +
    'Rules:\n' +
    '- One item for every product line the user wrote, in the same order. Write the material name in proper English (Painted aluminium profiles, PVC, Powder coated clean aluminium scrap, and so on), keeping what the user meant.\n' +
    '- A bare number after an item is its price per metric ton in ' + q.cur + ' unless the user wrote another currency: write mech as "' + q.cur + ' 8,200 per MT". For LME pricing write it as stated, for example "LME Cash Aluminium less 12%".\n' +
    '- The customer is the company after "عرض ل", "for" or "to". Keep its name exactly as written (fix only the word for company).\n' +
    '- NEVER invent prices, percentages, quantities, places or names. Leave a field empty when it was not given.\n' +
    '- Add a term only for payment, validity, delivery or VAT details the user mentioned.\n' +
    '- subject: "Supply of " + the materials. intro: one or two formal sentences. closing: one formal sentence.';
}

function pickInv(d) {
  return { text: str(d.text, 9000), side: d.side === 'buy' ? 'buy' : 'sell', ownName: str(d.ownName, 120), ownTrn: String(d.ownTrn || '').replace(/[^0-9A-Za-z]/g, '').slice(0, 20) };
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

function reply(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: JSON_HEADERS });
}

// Short text and numbers only: the customer message and the shipment explanation are built from these fields alone.
function str(v, max) { return typeof v === 'string' ? v.trim().slice(0, max) : ''; }
function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }

// For a customer message: no cost, profit or supplier is kept, even if the app sends them.
function pickMsg(d) {
  const items = (Array.isArray(d.items) ? d.items : []).slice(0, 20).map((it) => ({
    name: str(it && it.name, 80), tons: num(it && it.tons)
  }));
  return { customer: str(d.customer, 120), date: str(d.date, 20), sold: d.sold === true, items, sell: num(d.sell), sellCur: str(d.sellCur, 5), origin: str(d.origin, 40), dest: str(d.dest, 40), transport: str(d.transport, 12) };
}

function pickExplain(d) {
  return {
    date: str(d.date, 20), customer: str(d.customer, 120), supplier: str(d.supplier, 120), currency: str(d.currency, 5), origin: str(d.origin, 40), dest: str(d.dest, 40), transport: str(d.transport, 12),
    sold: d.sold === true, tons: num(d.tons), buy: num(d.buy), sell: num(d.sell), costs: num(d.costs), profit: num(d.profit),
    marginPercent: d.marginPercent == null ? null : num(d.marginPercent)
  };
}

// Turns the request into chat messages, or into { error } with a message for the user.
function prepare(body) {
  const en = !!body && body.lang === 'en';
  const t = (ar, english) => (en ? english : ar);
  if (!body || typeof body !== 'object') return { error: t('طلب غير صالح', 'Invalid request') };
  if (['ask', 'month', 'msg', 'explain', 'inv', 'invimg', 'quote'].indexOf(body.kind) < 0) return { error: t('نوع الطلب غير معروف', 'Unknown request type') };
  let data = body.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { error: t('لا توجد بيانات للتحليل', 'There is no data to analyse') };
  if (body.kind === 'invimg') {
    const img = typeof data.image === 'string' ? data.image : '';
    if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(img)) return { error: t('صورة الفاتورة غير صالحة', 'The invoice image is not valid') };
    if (img.length > MAX_IMG_BODY) return { error: t('صورة الفاتورة كبيرة جداً', 'The invoice image is too large') };
    const d = pickInv({ text: '', side: data.side, ownName: data.ownName, ownTrn: data.ownTrn });
    return {
      model: VISION_MODEL, maxTokens: MAX_TOKENS_SHORT, temperature: 0, vision: true,
      messages: [
        { role: 'system', content: invSys(d).replace('You read the text of a Gulf (GCC) tax invoice. The text was extracted from a PDF or a photo, so it can contain OCR mistakes, broken lines and missing Arabic words.', 'You read a photo or scan of a Gulf (GCC) tax invoice. It may be in English or Arabic, rotated, or photographed at an angle. Read every printed figure carefully.') },
        { role: 'user', content: [ { type: 'text', text: 'Read this invoice and return the JSON object now.' }, { type: 'image_url', image_url: { url: img } } ] }
      ]
    };
  }
  if (body.kind === 'msg') data = pickMsg(data);
  if (body.kind === 'explain') data = pickExplain(data);
  if (body.kind === 'quote') {
    const q = { text: str(data.text, 2500), co: str(data.co, 200), today: str(data.today, 12), cur: str(data.cur, 5) || 'AED' };
    if (q.text.replace(/\s/g, '').length < 4) return { error: t('اكتب وصف العرض أولاً', 'Describe the quotation first') };
    return {
      maxTokens: MAX_TOKENS, temperature: 0.1,
      messages: [
        { role: 'system', content: quoteSys(q) },
        { role: 'user', content: 'Request:\n<<<\n' + q.text + '\n>>>\nReturn the JSON object now.' + NO_THINK }
      ]
    };
  }
  if (body.kind === 'inv') {
    data = pickInv(data);
    if (data.text.replace(/\s/g, '').length < 20) return { error: t('لا يوجد نص كافٍ في الفاتورة', 'There is not enough text in the invoice') };
    return {
      maxTokens: MAX_TOKENS_SHORT, temperature: 0,
      messages: [
        { role: 'system', content: invSys(data) },
        { role: 'user', content: 'Invoice text:\n<<<\n' + data.text + '\n>>>\nReturn the JSON object now.' + NO_THINK }
      ]
    };
  }
  const dataText = JSON.stringify(data);
  if (dataText.length > MAX_DATA_CHARS) return { error: t('البيانات كبيرة جداً، اختر فترة أقصر', 'The data is too large, choose a shorter period') };

  if (body.kind === 'ask') {
    const question = typeof body.question === 'string' ? body.question.trim() : '';
    if (!question) return { error: t('اكتب سؤالك أولاً', 'Write your question first') };
    if (question.length > MAX_QUESTION) return { error: t('السؤال طويل، اختصره وأعد الإرسال', 'The question is too long, shorten it and send again') };
    const history = (Array.isArray(body.history) ? body.history : [])
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
      .slice(-MAX_HISTORY)
      .map((m) => ({ role: m.role, content: m.content.trim().slice(0, MAX_TURN) }));
    while (history.length && history[0].role !== 'user') history.shift(); // the chat must start with a question
    return {
      maxTokens: MAX_TOKENS,
      messages: [
        { role: 'system', content: (en ? ASK_SYS_EN : ASK_SYS) + '\n\n' + t('بيانات الشحنات (JSON):', 'Shipment data (JSON):') + '\n' + dataText },
        ...history,
        { role: 'user', content: question + NO_THINK }
      ]
    };
  }

  if (body.kind === 'month') {
    const label = typeof data.month === 'string' ? data.month.slice(0, 40) : t('هذا الشهر', 'this month');
    return {
      maxTokens: MAX_TOKENS,
      messages: [
        { role: 'system', content: (en ? MONTH_SYS_EN : MONTH_SYS) + '\n\n' + t('بيانات الشهر (JSON):', 'Month data (JSON):') + '\n' + dataText },
        { role: 'user', content: en ? 'Write the report for ' + label + ' now.' + NO_THINK : 'اكتب تقرير ' + label + ' الآن.' + NO_THINK }
      ]
    };
  }

  if (body.kind === 'msg') {
    return {
      maxTokens: MAX_TOKENS_SHORT,
      messages: [
        { role: 'system', content: (en ? MSG_SYS_EN : MSG_SYS) + '\n\n' + t('بيانات الشحنة (JSON):', 'Shipment data (JSON):') + '\n' + dataText },
        { role: 'user', content: en ? 'Write the customer message now.' + NO_THINK : 'اكتب رسالة العميل الآن.' + NO_THINK }
      ]
    };
  }

  // explain
  return {
    maxTokens: MAX_TOKENS_SHORT,
    messages: [
      { role: 'system', content: (en ? EXPLAIN_SYS_EN : EXPLAIN_SYS) + '\n\n' + t('بيانات الشحنة (JSON):', 'Shipment data (JSON):') + '\n' + dataText },
      { role: 'user', content: en ? 'Explain this shipment now.' + NO_THINK : 'اشرح نتيجة هذه الشحنة الآن.' + NO_THINK }
    ]
  };
}

// Text of a value that is either a string or a list of content parts ({ type, text }).
function textOf(v) {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    return v.map((p) => (typeof p === 'string' ? p : p && typeof p.text === 'string' ? p.text : '')).join('');
  }
  return '';
}

// Removes reasoning blocks and Markdown marks. Returns '' when no answer text is left.
function clean(t) {
  let s = t.replace(/<think>[\s\S]*?<\/think>/g, '');
  if (s.includes('<think>')) s = s.slice(0, s.indexOf('<think>')); // thinking that never finished: nothing usable in it
  return s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/^#{1,6}\s*/gm, '').trim();
}

// The answer text, whichever shape Workers AI returned. Reasoning alone gives ''.
function pickText(out, en) {
  if (typeof out === 'string') return clean(out);
  if (!out || typeof out !== 'object') return '';
  const choice = Array.isArray(out.choices) ? out.choices[0] : null;
  const items = Array.isArray(out.output) ? out.output : [];
  const candidates = [
    out.response,
    out.result && out.result.response,
    choice && choice.message && choice.message.content,
    choice && choice.text,
    out.output_text,
    ...items.map((item) => item && item.content)
  ];
  for (const c of candidates) {
    const t = clean(textOf(c));
    if (t) return t;
  }
  // Thinking is switched off, so the serving layer can file a finished answer under "reasoning" instead of
  // "content". Use it only when the reply finished on its own. In Arabic mode it must contain Arabic, so
  // hidden English thinking is never shown; in English mode the answer itself is English.
  const msg = (choice && choice.message) || {};
  if (choice && choice.finish_reason === 'stop') {
    for (const c of [msg.reasoning_content, msg.reasoning]) {
      const t = clean(textOf(c));
      if (t && (en || /[؀-ۿ]/.test(t))) return t;
    }
  }
  return '';
}

// The structure of a reply (keys, types and lengths, never the answer text), for debugging.
function shapeOf(v, depth) {
  const d = depth || 0;
  if (v === null) return 'null';
  if (typeof v === 'string') return v.length <= 20 ? JSON.stringify(v) : 'string(' + v.length + ')';
  if (typeof v !== 'object') return typeof v;
  if (d >= 5) return Array.isArray(v) ? 'array(' + v.length + ')' : 'object';
  if (Array.isArray(v)) {
    return '[' + v.slice(0, 2).map((x) => shapeOf(x, d + 1)).join(', ') + (v.length > 2 ? ', …' : '') + ']';
  }
  return '{' + Object.keys(v).slice(0, 12).map((k) => k + ': ' + shapeOf(v[k], d + 1)).join(', ') + '}';
}

export async function onRequestPost(context) {
  const { request, env } = context;

  // Only the app's own page may call this. Browsers send Origin, so other websites are refused.
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return reply({ error: 'هذا الطلب غير مسموح به' }, 403);

  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_IMG_BODY + 4096) return reply({ error: 'البيانات المرسلة كبيرة جداً' }, 413);
  const raw = await request.text();
  if (raw.length > MAX_IMG_BODY + 4096 || (raw.length > MAX_BODY_BYTES && raw.indexOf('"kind":"invimg"') < 0)) return reply({ error: 'البيانات المرسلة كبيرة جداً' }, 413);

  let body;
  try {
    body = JSON.parse(raw);
  } catch (e) {
    return reply({ error: 'طلب غير صالح' }, 400);
  }
  const en = !!body && body.lang === 'en';
  const prepared = prepare(body);
  if (prepared.error) return reply({ error: prepared.error }, 400);

  if (!env || !env.AI) {
    return reply({ error: en
      ? 'The AI service is not connected to the site yet. In Cloudflare, add Workers AI with the name AI under Settings → Bindings, then redeploy'
      : 'خدمة الذكاء الصناعي غير مربوطة بالموقع بعد. في Cloudflare أضف Workers AI باسم AI من Settings → Bindings ثم أعد النشر' }, 503);
  }

  try {
    const input = {
      messages: prepared.messages,
      max_tokens: prepared.maxTokens || MAX_TOKENS,
      temperature: prepared.temperature != null ? prepared.temperature : 0.2
    };
    if (!prepared.vision) input.chat_template_kwargs = { enable_thinking: false }; // a Qwen3 switch; other models do not take it
    const out = await env.AI.run(prepared.model || MODEL, input);
    const text = pickText(out, en);
    if (!text) {
      const shape = shapeOf(out).slice(0, 400);
      console.error('Empty model output, shape: ' + shape);
      return reply({ error: en
        ? 'No reply came from the model. Try again, or make the question shorter. Details for review: ' + shape
        : 'لم يصل رد من النموذج، جرّب مرة أخرى أو اختصر السؤال. تفاصيل للمراجعة: ' + shape }, 502);
    }
    return reply({ text });
  } catch (err) {
    const msg = String((err && err.message) || err || '');
    console.error('Workers AI call failed: ' + msg.slice(0, 300));
    if (/neuron|allocation|quota|\b4006\b|rate limit|\b429\b/i.test(msg)) {
      return reply({ error: en
        ? 'The free daily allowance is used up. It renews every day at midnight UTC, or try again later'
        : 'انتهت الحصة المجانية لليوم. تتجدد يومياً عند منتصف الليل بتوقيت UTC، أو جرّب لاحقاً' }, 429);
    }
    return reply({ error: en
      ? 'Could not get a reply, please try again in a moment'
      : 'تعذّر الحصول على الرد، حاول مرة أخرى بعد قليل' }, 502);
  }
}
