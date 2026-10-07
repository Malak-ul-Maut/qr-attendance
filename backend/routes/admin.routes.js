import express from 'express';
import { requireAdmin } from '../utils/admin-auth.js';
import analyticsRouter from './admin/analytics.js';
import masterRouter from './admin/master.js';
import timetableRouter from './admin/timetable.js';
import enrollmentRouter from './admin/enrollment.js';
import importRouter from './admin/import.js';

// Every admin endpoint needs the admin token issued at login.
const router = express.Router();
router.use(requireAdmin);
router.use('/analytics', analyticsRouter);
router.use('/master', masterRouter);
router.use('/timetable', timetableRouter);
router.use('/enrollment', enrollmentRouter);
router.use('/import', importRouter);

export default router;
