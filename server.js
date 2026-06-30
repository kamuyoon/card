// Node 18 + undici 호환 패치
if (typeof File === 'undefined') {
  global.File = require('buffer').File;
}

const express   = require('express');
const multer    = require('multer');
const path      = require('path');
const https     = require('https');
const http      = require('http');
const Anthropic = require('@anthropic-ai/sdk');
const OpenAI    = require('openai');

const PORT          = process.env.PORT              || 3001;
const ADMIN_KEY     = process.env.ADMIN_KEY         || 'cardnews2024';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const OPENAI_KEY    = process.env.OPENAI_API_KEY    || '';

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

// 카드뉴스 생성 (Claude)
app.post('/api/generate', checkAdmin, async (req, res) => {
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY 환경변수 미설정' });
  const { text, cardCount = 7, topic = '' } = req.body;
  if (!text) return res.status(400).json({ error: '텍스트 필요' });

  const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });
  const ACCENTS = ['#FF6B35','#00D4FF','#A78BFA','#34D399','#FBBF24','#F472B6','#60A5FA','#F87171','#2DD4BF'];
  const accentList = ACCENTS.slice(0, Number(cardCount)).join(', ');

  const prompt = `당신은 대한민국 최고의 인스타그램 카드뉴스 크리에이터이자 심리 마케터입니다.
Al Ries의 포지셔닝, Seth Godin의 마케팅 철학, Brendan Kane의 바이럴 공식을 완벽히 구현합니다.

[입력 원문 — 영어일 경우 핵심을 한국어로 번역해 활용]
${text.substring(0, 4500)}

${topic ? `[추가 키워드/방향] ${topic}` : ''}

[제작 규칙]
총 ${cardCount}장.

카드 1 (훅): 독자가 스크롤을 멈추는 충격/호기심 문장. "99%가 모르는..." 형식 권장. headline 최대 18자.
카드 2~${Number(cardCount)-1} (핵심): 카드당 하나의 강력한 인사이트. 숫자/사례 우선. headline 최대 20자, body 최대 60자.
카드 ${cardCount} (마무리): 핵심 한 줄 요약 또는 CTA.

모든 텍스트 한국어. headline은 읽는 순간 멈춰야 함.
각 카드 accent 색상 순서대로: ${accentList}

[반드시 아래 JSON만 응답]
{
  "seriesTitle": "시리즈 제목 (20자 이내)",
  "cards": [
    {
      "number": 1,
      "type": "hook",
      "headline": "헤드라인",
      "subheadline": "서브헤드라인 (없으면 빈 문자열)",
      "body": "본문",
      "accent": "#FF6B35",
      "imagePrompt": "Abstract minimalist concept in English for DALL-E 3. Dark moody atmosphere, cinematic lighting, no text."
    }
  ]
}`;

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 3500,
      messages: [{ role: 'user', content: prompt }]
    });
    const raw = msg.content[0].text;
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('카드 데이터 파싱 실패 — 다시 시도해주세요');
    res.json(JSON.parse(match[0]));
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
      prompt: `${prompt}. Ultra minimalist, dark moody cinematic, Apple aesthetic, professional photography. No text, no words, no letters anywhere.`,
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
  res.json({ anthropic: !!ANTHROPIC_KEY, openai: !!OPENAI_KEY });
});

app.listen(PORT, () => {
  console.log(`🎨 카드뉴스 공장 → http://localhost:${PORT}`);
  console.log(`   Anthropic: ${ANTHROPIC_KEY ? '✓' : '✗ 미설정'}`);
  console.log(`   OpenAI   : ${OPENAI_KEY    ? '✓' : '✗ 미설정'}`);
});
