import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import authRouter from "./auth.js";
import intelligenceRouter from "./intelligence.js";
import intelligenceBriefRouter from "./intelligence/brief.js";
import voiceRouter from "./voice.js";
import voiceEventsRouter from "./voiceEvents.js";
import ussdRouter from "./ussd.js";
import smsRouter from "./sms.js";
import pastoralistsRouter from "./pastoralists.js";
import chatRouter from "./chat.js";
import callTokensRouter from "./callTokens.js";
import groundTruthRouter from "./groundTruth.js";
import publicTalkRouter from "./publicTalk.js";
import openDataRouter from "./openData.js";
import llmRouter from "./llm.js";
import satelliteRouter from "./satellite.js";
import speechRouter from "./speech.js";
import talkRouter from "./talk.js";
import demoRouter from "./demo/index.js";

const router: IRouter = Router();

// Production routes
router.use(healthRouter);
router.use(authRouter);
router.use(intelligenceRouter);
router.use(intelligenceBriefRouter);
router.use(voiceRouter);
router.use(voiceEventsRouter);
router.use(ussdRouter);
router.use(smsRouter);
router.use(pastoralistsRouter);
router.use(chatRouter);
router.use(callTokensRouter);
router.use(groundTruthRouter);
router.use(publicTalkRouter);
router.use(openDataRouter);
router.use(llmRouter);
router.use(satelliteRouter);
router.use(speechRouter);
router.use(talkRouter);

// Demo routes (for local testing without Africa's Talking)
router.use("/demo", demoRouter);

export default router;
