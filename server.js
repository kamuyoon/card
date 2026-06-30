// Node 18 + undici 호환 패치
if (typeof File === 'undefined') {
  global.File = require('buffer').File;
}

const express = require('express');
const multer  = require('multer');
const path    = require('path');
const https   = require('https');
const http    = require('http');
const OpenAI  = require('openai');

const PORT       = process.env.PORT           || 3001;
const ADMIN_KEY  = process.env.ADMIN_KEY      || 'cardnews2024';
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

const checkAdmin = (req, res, next) => {
  const key = req.headers['x-admin-key'] || req.query.key;
  if (key !== ADMIN_KEY) return res.status(401).json({ error: '인증 필요' });
  next();
};

// PDF / 텍스트 추출
app.post('/api/extract', checkAdmin, upload.single('file'), async (req, res) => {
  try {
    let text = '';
    if (req.file) {
      if (req.file.mimetype === 'application/pdf' || req.file.originalname?.endsWith('.pdf')) {
        const pdfParse = require('pdf-parse');
        const data = await pdfParse(req.file.buffer);
        text = data.text;
      } else {
        text = req.file.buffer.toString('utf8');
      }
    } else if (req.body?.text) {
      text = req.body.text;
    }
    text = text.replace(/\s{3,}/g, '\n\n').trim();
    if (!text) return res.status(400).json({ error: '텍스트를 찾을 수 없습니다' });
    res.json({ text: text.substring(0, 15000), totalLength: text.length });
  } catch (e) {
    console.error('[extract]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// 카드뉴스 생성 (GPT-4o)
app.post('/api/generate', checkAdmin, async (req, res) => {
  if (!OPENAI_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY 환경변수 미설정' });
  const { text, cardCount = 7, topic = '' } = req.body;
  if (!text) return res.status(400).json({ error: '텍스트 필요' });

  const openai = new OpenAI({ apiKey: OPENAI_KEY });
  const ACCENTS = ['#FF6B35','#00D4FF','#A78BFA','#34D399','#FBBF24','#F472B6','#60A5FA','#F87171','#2DD4BF'];
  const accentList = ACCENTS.slice(0, Number(cardCount)).join(', ');

  const systemPrompt = `당신은 해당 분야 최고 전문가이자 팔로워 100만의 인스타그램 카드뉴스 크리에이터입니다.

[핵심 임무]
원문에서 "대부분의 사람이 모르는 진짜 인사이트"만 골라, 독자가 카드를 다 읽고 나면 실제로 뭔가를 알게 되는 카드뉴스를 만드세요.

[퀄리티 기준 — 반드시 지켜야 할 원칙]

1. 구체성 원칙
   - 모든 카드에 수치, 공식, 구체적 방법 중 하나 이상 포함
   - 나쁜 예: "단백질 섭취가 근육 성장에 중요합니다"
   - 좋은 예: "근육 유지엔 체중 1파운드당 최소 1.1g 단백질이 필요합니다. 150파운드라면 165g입니다."

2. 정보 밀도 원칙
   - body는 짧게 요약하지 말고, 독자가 읽고 나서 실제로 뭔가를 배웠다고 느낄 만큼 충분히 써주세요
   - 구체적인 수치 예시, 계산 방법, 실제 적용 방법을 포함하세요
   - 읽고 나서 "그래서 어떻게 하라고?"가 남으면 안 됩니다

3. 반직관성 원칙
   - 독자가 이미 아는 내용이면 카드 낭비입니다
   - 원문에서 상식을 뒤집거나 의외성 있는 사실만 선택하세요

4. 스토리 흐름 원칙
   - 카드들이 하나의 이야기처럼 연결되어야 합니다
   - 카드 1에서 던진 문제가 카드 2~끝까지 이어지며 풀려야 합니다
   - 각 카드가 독립적인 정보 조각이 되면 안 됩니다

5. 훅 원칙 (카드 1)
   - 첫 카드는 독자가 스크롤을 멈추게 해야 합니다
   - 가장 충격적이거나 반직관적인 사실로 시작하세요

6. 존댓말 원칙
   - 모든 본문은 반드시 존댓말로 작성하세요 (~입니다, ~합니다, ~하세요)
   - 반말 절대 금지 (~다, ~하라, ~마라, ~된다)`;

  const userPrompt = `[원문 — 영어면 핵심 번역해서 활용]
${text.substring(0, 12000)}

${topic ? `[추가 방향] ${topic}` : ''}

위 원문으로 ${cardCount}장 카드뉴스를 제작해주세요:
- 카드 1: 가장 반직관적이거나 충격적인 사실로 훅 (독자를 멈추게 할 것)
- 카드 2~${Number(cardCount)-1}: 카드 1에서 던진 주제를 구체적으로 풀어가는 흐름 (공식/수치/방법 포함, 존댓말)
- 카드 ${cardCount}: 전체 흐름을 마무리하는 실행 가이드 또는 핵심 요약

[작성 기준]
- headline: 최대 22자, 궁금증을 유발하거나 핵심을 담은 문장
- subheadline: 헤드라인을 보완하는 한 줄 (없으면 빈 문자열)
- body: 150~250자, 구체적 수치/공식/예시 포함, 존댓말로 작성
- 전체 한국어, 반말 절대 금지
- accent 색상 순서: ${accentList}

JSON만 응답:
{
  "seriesTitle": "시리즈 제목 (20자 이내)",
  "cards": [
    {
      "number": 1,
      "type": "hook",
      "headline": "헤드라인",
      "subheadline": "서브헤드라인 (없으면 빈 문자열)",
      "body": "본문 (150~250자, 존댓말, 구체적 수치/공식 포함)",
      "accent": "#FF6B35",
      "imagePrompt": "Editorial photography style, cinematic, moody lighting, no text, no people. Describe a specific real-world scene or object related to the card topic."
    }
  ]
}`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 4000,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    });
    res.json(JSON.parse(completion.choices[0].message.content));
  } catch (e) {
    console.error('[generate]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// DALL-E 이미지 생성 (base64 반환 — CORS 방지)
app.post('/api/image', checkAdmin, async (req, res) => {
  if (!OPENAI_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY 환경변수 미설정' });
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: '프롬프트 필요' });

  const openai = new OpenAI({ apiKey: OPENAI_KEY });
  try {
    const response = await openai.images.generate({
      model: 'dall-e-3',
      prompt: `${prompt}. Ultra minimalist, dark moody cinematic, Apple aesthetic, professional photography. Absolutely no text, no words, no letters anywhere in the image.`,
      size: '1024x1024',
      quality: 'standard',
      n: 1,
    });
    const imageUrl = response.data[0].url;
    const imgBase64 = await new Promise((resolve, reject) => {
      const parsed = new URL(imageUrl);
      const lib = parsed.protocol === 'https:' ? https : http;
      lib.get(imageUrl, (imgRes) => {
        const chunks = [];
        imgRes.on('data', c => chunks.push(c));
        imgRes.on('end', () => resolve(Buffer.concat(chunks).toString('base64')));
        imgRes.on('error', reject);
      }).on('error', reject);
    });
    res.json({ imageData: `data:image/png;base64,${imgBase64}` });
  } catch (e) {
    console.error('[image]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/status', checkAdmin, (_req, res) => {
  res.json({ anthropic: !!OPENAI_KEY, openai: !!OPENAI_KEY });
});

app.listen(PORT, () => {
  console.log(`🎨 카드뉴스 공장 → http://localhost:${PORT}`);
  console.log(`   OpenAI: ${OPENAI_KEY ? '✓' : '✗ 미설정'}`);
});
