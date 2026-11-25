/**
 * Adversarial Security Test Suite — Dirty Dozen Verification
 * Validates that all adversarial payloads in security_spec.md return PERMISSION_DENIED.
 */

export interface AdversarialTestCase {
  id: number;
  name: string;
  operation: 'get' | 'list' | 'create' | 'update' | 'delete';
  path: string;
  auth: {
    uid: string;
    email: string;
    email_verified: boolean;
  } | null;
  payload?: Record<string, unknown>;
  expectedOutcome: 'PERMISSION_DENIED';
}

export const DIRTY_DOZEN_TEST_CASES: AdversarialTestCase[] = [
  {
    id: 1,
    name: 'Unverified Admin Email Spoof',
    operation: 'create',
    path: 'tasks/task_spoof_1',
    auth: { uid: 'spoof1', email: 'a.biagi@sitespa.it', email_verified: false },
    payload: { taskId: 'task_spoof_1', commessa: 'H265001' },
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 2,
    name: 'Self-Privilege Escalation on Registration',
    operation: 'create',
    path: 'users/tech_1',
    auth: { uid: 'tech_1', email: 'm.rossi@sitespa.it', email_verified: true },
    payload: {
      uid: 'tech_1',
      email: 'm.rossi@sitespa.it',
      nome: 'Mario',
      cognome: 'Rossi',
      role: 'admin',
      active: true,
    },
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 3,
    name: 'Shadow Field Injection on Task Update',
    operation: 'update',
    path: 'tasks/task_1',
    auth: { uid: 'tech_1', email: 'm.rossi@sitespa.it', email_verified: true },
    payload: { statoPrevalente: 'Preso in Carico', ghostAdminFlag: true },
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 4,
    name: 'PII Scraping on Other User Profile',
    operation: 'get',
    path: 'users/other_tech_uid',
    auth: { uid: 'tech_1', email: 'm.rossi@sitespa.it', email_verified: true },
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 5,
    name: 'PII Roster Scraping on Directory',
    operation: 'get',
    path: 'directory/staff_other',
    auth: { uid: 'tech_1', email: 'm.rossi@sitespa.it', email_verified: true },
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 6,
    name: 'Orphaned Assignment Creation Without Parent Task',
    operation: 'create',
    path: 'assignments/asg_orphan',
    auth: { uid: 'admin_1', email: 'a.biagi@sitespa.it', email_verified: true },
    payload: { assignmentId: 'asg_orphan', taskId: 'non_existent_task_999' },
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 7,
    name: 'Terminal State Bypass on Completed Assignment',
    operation: 'update',
    path: 'assignments/asg_completed',
    auth: { uid: 'tech_1', email: 'm.rossi@sitespa.it', email_verified: true },
    payload: { stato: 'Preso in Carico', noteTecnico: 'Reopened illegally' },
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 8,
    name: 'Cross-Technician Material Identity Spoofing',
    operation: 'create',
    path: 'usedMaterials/mat_spoof',
    auth: { uid: 'tech_1', email: 'm.rossi@sitespa.it', email_verified: true },
    payload: { usedId: 'mat_spoof', technicianUid: 'tech_2', quantita: 2 },
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 9,
    name: 'Premature Photo Upload While Assignment Is Still Assegnato',
    operation: 'create',
    path: 'interventionPhotos/photo_early',
    auth: { uid: 'tech_1', email: 'm.rossi@sitespa.it', email_verified: true },
    payload: { photoId: 'photo_early', assignmentId: 'asg_unstarted' },
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 10,
    name: 'Negative Material Quantity Poisoning',
    operation: 'create',
    path: 'usedMaterials/mat_neg',
    auth: { uid: 'tech_1', email: 'm.rossi@sitespa.it', email_verified: true },
    payload: { usedId: 'mat_neg', assignmentId: 'asg_active', quantita: -3 },
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 11,
    name: 'Denial-of-Wallet Oversized Array (>10 Assigned Emails)',
    operation: 'create',
    path: 'tasks/task_dow',
    auth: { uid: 'admin_1', email: 'a.biagi@sitespa.it', email_verified: true },
    payload: {
      taskId: 'task_dow',
      assignedEmails: Array.from({ length: 15 }, (_, i) => `t${i}@sitespa.it`),
    },
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 12,
    name: 'Client Timestamp Forgery on Article Creation',
    operation: 'create',
    path: 'articles/art_forged_time',
    auth: { uid: 'admin_1', email: 'a.biagi@sitespa.it', email_verified: true },
    payload: {
      articleId: 'art_forged_time',
      createdAt: '2020-01-01T00:00:00Z',
    },
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 13,
    name: 'Cross-Technician Absence Spoofing',
    operation: 'create',
    path: 'absences/abs_spoof_other',
    auth: { uid: 'tech_1', email: 'm.rossi@sitespa.it', email_verified: true },
    payload: {
      absenceId: 'abs_spoof_other',
      technicianEmail: 'l.bianchi@sitespa.it',
      technicianUid: 'tech_2',
      tipo: 'Ferie',
      createdByRole: 'technician',
    },
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 14,
    name: 'Autonomous Technician Task Forging Commessa Without Admin Review',
    operation: 'create',
    path: 'tasks/task_aut_forged',
    auth: { uid: 'tech_1', email: 'm.rossi@sitespa.it', email_verified: true },
    payload: {
      taskId: 'task_aut_forged',
      commessa: 'H265001',
      pendingAdminReview: false,
      createdByRole: 'technician',
      assignedEmails: ['m.rossi@sitespa.it'],
    },
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 15,
    name: 'Non-Admin Push Subscription Registration Attempt',
    operation: 'create',
    path: 'pushSubscriptions/push_tech_hijack',
    auth: { uid: 'tech_1', email: 'm.rossi@sitespa.it', email_verified: true },
    payload: {
      subId: 'push_tech_hijack',
      ownerUid: 'tech_1',
      endpoint: 'https://fcm.googleapis.com/fcm/send/example-token',
      p256dh: 'BExamplePublicKey1234567890',
      auth: 'ExampleAuthKey123',
      deviceLabel: 'Smartphone Tecnico',
      active: true,
      adminUids: [],
    },
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 16,
    name: 'Invalid Task Color Value Poisoning',
    operation: 'update',
    path: 'tasks/task_1',
    auth: { uid: 'admin_1', email: 'a.biagi@sitespa.it', email_verified: true },
    payload: {
      colorId: 'neon_pink_invalid_color',
    },
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 17,
    name: 'Unauthorized Squad Names Mutation by Technician on Assignment',
    operation: 'update',
    path: 'assignments/asg_1',
    auth: { uid: 'tech_1', email: 'm.rossi@sitespa.it', email_verified: true },
    payload: {
      stato: 'Preso in Carico',
      squadNames: ['Mario Rossi', 'Fake Colleague'],
    },
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 18,
    name: 'Direct Parent Task Status Update by Technician Blocked (Single-Rail Assignment Only)',
    operation: 'update',
    path: 'tasks/task_mvti4kur_witisqfv',
    auth: {
      uid: 'rXvJlAYTBmdmgzUwKQpmUPEOT4o1',
      email: 'andrea.maiorano.id@sitespa.it',
      email_verified: true,
    },
    payload: {
      statoPrevalente: 'Preso in Carico',
      assignedStatuses: ['Preso in Carico', 'Assegnato'],
    },
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 19,
    name: 'Cross-Squad Colleague Assignment Status Mutation Blocked',
    operation: 'update',
    path: 'assignments/asg_colleague_other',
    auth: {
      uid: 'tech_other_uid',
      email: 'm.rossi.id@sitespa.it',
      email_verified: true,
    },
    payload: {
      stato: 'Completato',
      noteTecnico: 'Chiuso per conto del collega',
    },
    expectedOutcome: 'PERMISSION_DENIED',
  },
  {
    id: 20,
    name: 'Cross-User Directory Link Hijacking on UserProfile Blocked',
    operation: 'update',
    path: 'users/tech_other_uid',
    auth: {
      uid: 'tech_other_uid',
      email: 'm.rossi.id@sitespa.it',
      email_verified: true,
    },
    payload: {
      directoryMemberId: 'staff_maiorano_id',
    },
    expectedOutcome: 'PERMISSION_DENIED',
  },
];

