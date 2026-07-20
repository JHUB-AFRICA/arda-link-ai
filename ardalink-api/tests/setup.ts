/**
 * Vitest global setup — set fake env vars so module-load-time assertions
 * (DATABASE_URL, AZURE_OPENAI_*, AFRICASTALKING_*) don't crash during
 * test collection.
 */

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.PORT = "0";
process.env.DATABASE_URL =
  "postgresql://test:test@localhost:5432/ardalink_test";
process.env.AZURE_OPENAI_ENDPOINT = "https://test.openai.azure.com/";
process.env.AZURE_OPENAI_API_KEY = "test-key";
process.env.AZURE_OPENAI_CHAT_DEPLOYMENT = "gpt-4o";
process.env.AZURE_OPENAI_WHISPER_DEPLOYMENT = "whisper";
process.env.AZURE_OPENAI_REALTIME_DEPLOYMENT = "gpt-4o-realtime-preview";
process.env.GOOGLE_SERVICE_ACCOUNT_JSON =
  '{"type":"service_account","project_id":"test"}';
process.env.AFRICASTALKING_USERNAME = "sandbox";
process.env.AFRICASTALKING_API_KEY = "test-key";
process.env.AFRICASTALKING_CALLER_ID = "+254700000000";
process.env.RECIPIENT_PHONE = "+254700000000";
process.env.SESSION_SECRET = "test-session-secret-at-least-32-characters-long";
process.env.JWT_SECRET = "test-jwt-secret-at-least-32-chars-long";
process.env.TENANT_ATTESTATION_SECRET = "test-attestation-secret-32-chars-min";
