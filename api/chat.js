export const config = { runtime: 'edge' };

const SYSTEM_PROMPT = `You are the support assistant for EffectsFlow — video editing assets for Premiere Pro and After Effects.

Products:
- TextFlow ($67): 32+ text animations, plugin, lifetime updates, A-Z Masterclass, Priority Support
- EffectsFlow Bundle ($267): 360+ assets, 50+ text animations, 20+ transitions, 65+ overlays, 80+ backgrounds, 160 SFX, unlimited license, lifetime updates

Info: Works on Mac/Windows, Premiere Pro & After Effects 2024-2026, instant delivery, 30-day money-back guarantee, support@effectsflow.com, code TEXTFLOW = $100 off bundle

Be friendly, short answers, direct to theeffectsguy.store for purchases, email support@effectsflow.com for issues you can't solve.`;

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  
  const { messages } = await req.json();
  
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
      max_tokens: 300,
    }),
  });

  const data = await response.json();
  
  return new Response(JSON.stringify({ message: data.choices[0].message.content }), {
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}
