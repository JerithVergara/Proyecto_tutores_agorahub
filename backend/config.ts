const required = (key: string): string => {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
};

const xaiApiKey = process.env.XAI_API_KEY;
const groqApiKey = process.env.GROQ_API_KEY;
const requestedAiProvider = process.env.AI_PROVIDER?.trim().toLowerCase();
const resolveAiProvider = (): 'xai' | 'groq' => {
  if (!requestedAiProvider) return groqApiKey ? 'groq' : xaiApiKey ? 'xai' : 'groq';
  if (requestedAiProvider === 'groq') return 'groq';
  if (requestedAiProvider === 'xai' || requestedAiProvider === 'grok') return 'xai';
  throw new Error('AI_PROVIDER must be xai, grok, or groq.');
};
const aiProvider = resolveAiProvider();

export const config = {
  port: Number(process.env.PORT ?? 3000),
  supabaseUrl: required('SUPABASE_URL'),
  supabaseAnonKey: required('SUPABASE_ANON_KEY'),
  supabaseServiceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
  supabaseSchema: process.env.SUPABASE_SCHEMA ?? 'agorahub',
  corsOrigin: process.env.CORS_ORIGIN ?? '*',
  aiProvider,
  aiApiKey: aiProvider === 'xai' ? xaiApiKey : groqApiKey,
  aiModel:
    process.env.AI_MODEL ??
    (aiProvider === 'xai' ? (process.env.GROK_MODEL ?? 'grok-4.7') : (process.env.GROQ_MODEL ?? 'openai/gpt-oss-120b')),
  aiBaseUrl:
    process.env.AI_BASE_URL ??
    (aiProvider === 'xai' ? 'https://api.x.ai/v1' : (process.env.GROQ_BASE_URL ?? 'https://api.groq.com/openai/v1')),
  jitsiDomain: (process.env.JITSI_DOMAIN ?? 'meet.jit.si').replace(/^https?:\/\//, '').replace(/\/$/, ''),
  resendApiKey: process.env.RESEND_API_KEY,
  emailFrom: process.env.EMAIL_FROM,
  appUrl: process.env.APP_URL?.replace(/\/$/, ''),
  authRequireEmailConfirmation: process.env.AUTH_REQUIRE_EMAIL_CONFIRMATION === 'true',
};
