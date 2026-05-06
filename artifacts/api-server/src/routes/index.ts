import { Router, type IRouter } from "express";
import healthRouter from "./health";
import missionsRouter from "./missions";
import auditRouter from "./audit";
import rulesRouter from "./rules";
import marketRouter from "./market";
import executionRouter from "./execution";
import ledgerRouter from "./ledger";

const router: IRouter = Router();

router.use(healthRouter);
router.use(missionsRouter);
router.use(auditRouter);
router.use(rulesRouter);
router.use(marketRouter);
router.use(executionRouter);
router.use(ledgerRouter);

export default router;
