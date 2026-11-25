# Security Specification — Gestione Interventi SITE

## 1. Data Invariants

1. **Verified Identity**: Every read or write requires an authenticated user with `request.auth.token.email_verified == true`.
2. **Admin Privilege Verification**: Admin access is granted exclusively to verified bootstrapped emails (`a.biagi@sitespa.it`, `s.pistacchio@sitespa.it` and their corporate `.id@sitespa.it` / `@tecnicositepa.it` login aliases), users with an explicit grant document at `/admins/{request.auth.uid}`, or the single first-boot system initializer via an atomic batch creating `/admins/{request.auth.uid}` and `/settings/general` (`!exists(/settings/general)` + `existsAfter(/settings/general)`, with `/settings/general` permanently non-deletable). Users cannot self-assign `role == 'admin'` on `/users/{userId}` or `/directory/{memberId}`.
3. **PII Isolation & Multi-Alias Corporate Self Lookup**: `/users/{userId}` has `allow list: if false` and restricts `get` to owner or admin. Optional `directoryMemberId` on `/users/{userId}` is strictly verified against `/directory/$(incoming().directoryMemberId)` belonging to `request.auth` (preventing cross-user directory hijacking). `/directory/{memberId}` restricts `get`/`list` to admins or the verified technician via `email`, `secondaryEmail`, corporate SITE domain variants (`.id@sitespa.it`, `@sitespa.it`, `@tecnicositepa.it`, `@tecnicositespa.it`), or `linkedUid == request.auth.uid`. `/pushSubscriptions/{subId}` stores strictly zero PII and restricts `create`/`update`/`delete` exclusively to verified Admins.
4. **Temporal & Structural Integrity**: Every `Task` must satisfy `fineMs >= inizioMs + 3600000` (minimum 1-hour duration), strict `hasAll`/`hasOnly` keys, regex-guarded IDs (`^[a-zA-Z0-9_\-]+$`, max 128 chars), optional `colorId` strictly constrained to the 11 Google Calendar IDs, and server timestamps (`request.time`). `Task.commessa` may only be empty (`""`) when `altroReparto == true` or `pendingAdminReview == true`. `AppSettings.operatorColorLabels` is strictly bounded to the 11 palette keys with string labels `<= 40` chars. Every `Absence` (`/absences/{absenceId}`) must satisfy `fineMs >= inizioMs + 1800000` (minimum 30-minute duration) and `tipo in ['Ferie', 'Permesso', 'Malattia', 'Altro']`.
5. **Single-Rail Technician Execution & Terminal State Locking**:
   - `/tasks/{taskId}` `update` and `delete` are strictly restricted to verified Administrators (`isAdmin()`). Non-admin technicians NEVER update `/tasks/{taskId}`; instead, they update exclusively their own `/assignments/{assignmentId}` (`['stato', 'noteTecnico', 'technicianUid', 'updatedAt']`) while non-terminal (`existing().stato != 'Completato' && existing().stato != 'Annullato'`).
   - Ownership of `/assignments/{assignmentId}` (`isAssignmentOwnerDoc`) is verified via corporate SITE domain variants (`isOwnEmailOrAlt`), `technicianUid == request.auth.uid`, `technicianAliasEmails`, or the caller's verified `/users/{uid}` -> `/directory/{directoryMemberId}` link (allowing un-backfilled legacy assignments across `@tecnicositepa.it`, `@sitespa.it`, and `.id@sitespa.it` to be updated immediately).
   - Once an `Assignment` reaches terminal state `'Completato'` or `'Annullato'`, non-admin technicians are strictly blocked from updating the assignment or mutating child `usedMaterials` and `interventionPhotos`.
   - Technicians can only create `interventionPhotos` when the parent assignment belongs to them (`isAssignmentOwnerDoc`) and has been taken in charge (`stato != 'Assegnato'`, `stato != 'Completato'`, `stato != 'Annullato'`).
6. **Zero-Cost List Enforcement & Multi-Alias Squad Visibility**: No `get()` or `exists()` lookups appear inside `allow list` blocks across all 11 collections; all list rules evaluate `resource.data` directly against `request.auth` (`isOwnEmailOrAlt`, `isInEmailList`, and `request.auth.uid`, with optional fields guarded via `'field' in existing()` and bounded `assignedAclEmails <= 60`, `squadEmails <= 60`, `technicianAliasEmails <= 10`, `squadNames <= 10`, and `adminEmails <= 10`).

---

## 2. The "Dirty Dozen" Payloads

1. **Unverified Admin Email Spoof**: `{ auth: { uid: "spoof1", email: "a.biagi@sitespa.it", email_verified: false } }` attempting to create a `/tasks/task_1` document.
2. **Self-Privilege Escalation on Registration**: Regular technician creating `/users/tech_1` with `"role": "admin"`.
3. **Shadow Field Injection / Direct Task Update by Technician**: Assigned technician attempting any `update` on `/tasks/task_1` (e.g., `{ statoPrevalente: "Preso in Carico", updatedAt: SERVER_TIMESTAMP }`).
4. **PII Scraping on Users Collection**: Authenticated technician executing `getDoc('/users/other_tech_uid')` or `getDocs('/users')`.
5. **PII Roster Scraping on Directory**: Authenticated technician querying `/directory` for another colleague's record.
6. **Orphaned Assignment Creation**: Admin creating `/assignments/asg_1` referencing non-existent `taskId: "missing_task_999"`.
7. **Terminal State Bypass on Completed Assignment**: Technician attempting to modify `noteTecnico` or `stato` on `/assignments/asg_done` when `existing().stato == "Completato"`.
8. **Cross-Technician Material Injection**: Technician A creating `/usedMaterials/mat_1` with `technicianUid: "tech_B"` or on an assignment owned by Technician B.
9. **Premature Photo Upload Before "Preso in Carico"**: Technician creating `/interventionPhotos/photo_1` while parent assignment still has `stato == "Assegnato"`.
10. **Negative or Zero Material Quantity Poisoning**: Technician creating `/usedMaterials/mat_neg` with `quantita: -5` or `quantita: 0`.
11. **Denial-of-Wallet Oversized ID / Array**: Creating `/tasks/` with a 500-character poisoned ID or `assignedEmails` containing 50 elements (`> 10` limit).
12. **Client Timestamp Forgery**: Creating `/articles/art_1` with a backdated `createdAt` timestamp not equal to `request.time`.
13. **Cross-Technician Absence Spoofing**: Technician creating `/absences/abs_spoof` for another technician's email.
14. **Autonomous Task Commessa Forgery**: Technician creating `/tasks/task_aut_forged` with `pendingAdminReview: false`.
15. **Non-Admin Push Subscription Registration**: Technician attempting to create `/pushSubscriptions/push_tech_1` to hijack admin completion notifications.
16. **Invalid Task Color Value Poisoning**: Admin or technician attempting to write an unsupported `colorId` (`"neon_pink_1000"`) on `/tasks/task_1`.
17. **Unauthorized Squad Names Mutation by Technician**: Assigned technician attempting to modify `squadNames` on `/assignments/asg_1` during an update.
18. **Direct Parent Task Status Update by `.id@sitespa.it` Technician**: Technician `andrea.maiorano.id@sitespa.it` attempting `updateDoc` on `/tasks/task_1` instead of `/assignments/asg_1`.
19. **Cross-Squad Colleague Assignment Mutation**: Squad member `m.rossi@sitespa.it` attempting to update colleague `andrea.maiorano@tecnicositepa.it`'s `/assignments/asg_mvqukxvb_d9vfc0bx`.
20. **Cross-User Directory Link Spoofing on User Profile**: Technician attempting to set `directoryMemberId: "staff_other_colleague"` on `/users/tech_1` to hijack another colleague's Organico identity.
