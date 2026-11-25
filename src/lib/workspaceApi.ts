/**
 * Google Workspace & Server Email Integrations
 * - Google Drive API v3 (drive): Centralized Master Folder storage (1Ckkh1FQlZqjB8I8Aq-4ahSjDAva1ghLf),
 *   automatic Editor permission sharing from Organico, and zero-quota ownership consolidation to a.biagi@sitespa.it
 * - Centralized Server SMTP (/api/email/*): Automatic & manual notification emails for all accounts (including .id@sitespa.it)
 */

import {
  areSameTechnicianEmails,
  Assignment,
  BOOTSTRAPPED_ADMIN_EMAILS,
  canonicalTechnicianKey,
  DEFAULT_DRIVE_SHARED_FOLDER_ID,
  DEFAULT_DRIVE_SHARED_FOLDER_URL,
  extractDriveFolderId,
  InterventionPhoto,
  isLoginOnlyIdEmail,
  isWorkspaceDriveEmail,
  MASTER_DRIVE_OWNER_EMAIL,
  StaffMember,
  Task,
  UsedMaterial,
  VALIDATION_LIMITS,
} from '../types/domain';
import { ApiError, fetchApiJson } from './apiClient';
import { formatDateIt, formatTimeIt } from './exportUtils';
import {
  auth,
  ensureWorkspaceAccessToken,
  getAccessToken,
} from './firebase';

export interface DriveUploadResult {
  driveFileId: string;
  fileName: string;
  driveWebViewLink: string;
  driveThumbnailLink: string;
  folderPath: string;
  driveSubfolderId: string;
  ownerConsolidated: boolean;
}

export interface ResolvedDriveTaskFolder {
  masterFolderId: string;
  taskFolderId: string;
  folderPath: string;
  folderWebUrl: string;
}

export interface BatchPhotoUploadProgress {
  current: number;
  total: number;
  fileName: string;
}

function escapeDriveQueryValue(val: string): string {
  return val.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * Verifies that the authenticated user can access and write into the centralized master folder
 * owned by a.biagi@sitespa.it. Never falls back to personal root Drive.
 */
async function verifyMasterFolderAccess(
  accessToken: string,
  masterFolderId: string
): Promise<void> {
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
    masterFolderId
  )}?supportsAllDrives=true&fields=id,name,trashed,capabilities(canAddChildren)`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    if (res.status === 404 || res.status === 403) {
      throw new Error(
        `Accesso non ancora abilitato sulla cartella centrale Google Drive SITE. L'amministratore (${MASTER_DRIVE_OWNER_EMAIL}) attiva automaticamente i permessi Editor all'apertura del portale o dalla scheda Tecnici & Impostazioni.`
      );
    }
    const errText = await res.text();
    throw new Error(
      `Errore verifica cartella centrale Google Drive (${res.status}): ${errText}`
    );
  }

  const data = (await res.json()) as {
    id: string;
    trashed?: boolean;
    capabilities?: { canAddChildren?: boolean };
  };

  if (data.trashed) {
    throw new Error(
      `La cartella centrale Google Drive (${masterFolderId}) risulta nel cestino.`
    );
  }

  if (data.capabilities && data.capabilities.canAddChildren === false) {
    throw new Error(
      `Il tuo account ha accesso in sola lettura alla cartella centrale Google Drive SITE. Chiedi a ${MASTER_DRIVE_OWNER_EMAIL} di sincronizzare il permesso Editor.`
    );
  }
}

async function findOrCreateSubfolderInMaster(
  accessToken: string,
  masterFolderId: string,
  subfolderName: string
): Promise<string> {
  const cleanName = subfolderName.replace(/[\\/]/g, '-').trim() || 'Intervento';
  const q = `mimeType = 'application/vnd.google-apps.folder' and name = '${escapeDriveQueryValue(
    cleanName
  )}' and '${escapeDriveQueryValue(
    masterFolderId
  )}' in parents and trashed = false`;

  const searchUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(
    q
  )}&includeItemsFromAllDrives=true&supportsAllDrives=true&fields=files(id,name)&pageSize=5`;

  const searchRes = await fetch(searchUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!searchRes.ok) {
    const errText = await searchRes.text();
    throw new Error(
      `Errore ricerca sottocartella commessa su Google Drive (${searchRes.status}): ${errText}`
    );
  }

  const searchData = (await searchRes.json()) as {
    files?: { id: string; name: string }[];
  };
  if (searchData.files && searchData.files.length > 0) {
    return searchData.files[0].id;
  }

  const createRes = await fetch(
    'https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&fields=id,name',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: cleanName,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [masterFolderId],
      }),
    }
  );

  if (!createRes.ok) {
    const errText = await createRes.text();
    throw new Error(
      `Errore creazione sottocartella commessa su Google Drive (${createRes.status}): ${errText}`
    );
  }

  const created = (await createRes.json()) as { id: string };
  return created.id;
}

export const TEMPORARY_UNREVIEWED_FOLDER_PREFIX = 'DA_REVISIONARE';

export function formatTaskDriveSubfolderName(
  commessa: string,
  taskCode: string
): string {
  const cleanCommessa = (commessa || '').trim();
  const cleanCode = (taskCode || '').trim() || 'TASK';
  const prefix = cleanCommessa || TEMPORARY_UNREVIEWED_FOLDER_PREFIX;
  return `${prefix} - ${cleanCode}`.replace(/[\\/]/g, '-');
}

/**
 * Ensures the `<Commessa> - <TaskCode>` (or `DA_REVISIONARE - <TaskCode>` before review)
 * subfolder exists inside the centralized master Drive folder.
 */
export async function ensureTaskDriveFolder(params: {
  accessToken: string;
  masterFolderId?: string;
  commessa: string;
  taskCode: string;
}): Promise<ResolvedDriveTaskFolder> {
  const { accessToken, commessa, taskCode } = params;
  const resolvedMasterId = extractDriveFolderId(
    params.masterFolderId || DEFAULT_DRIVE_SHARED_FOLDER_ID
  );

  await verifyMasterFolderAccess(accessToken, resolvedMasterId);

  const safeTaskFolder = formatTaskDriveSubfolderName(commessa, taskCode);
  const taskFolderId = await findOrCreateSubfolderInMaster(
    accessToken,
    resolvedMasterId,
    safeTaskFolder
  );

  return {
    masterFolderId: resolvedMasterId,
    taskFolderId,
    folderPath: safeTaskFolder,
    folderWebUrl: `https://drive.google.com/drive/folders/${taskFolderId}`,
  };
}

/**
 * Searches for an existing subfolder by exact name inside the centralized master Drive folder
 * without creating one if absent.
 */
export async function findTaskDriveSubfolderByName(params: {
  accessToken: string;
  masterFolderId?: string;
  folderName: string;
}): Promise<{ id: string; name: string } | null> {
  const resolvedMasterId = extractDriveFolderId(
    params.masterFolderId || DEFAULT_DRIVE_SHARED_FOLDER_ID
  );
  const cleanName = params.folderName.replace(/[\\/]/g, '-').trim();
  if (!cleanName) return null;

  const q = `mimeType = 'application/vnd.google-apps.folder' and name = '${escapeDriveQueryValue(
    cleanName
  )}' and '${escapeDriveQueryValue(
    resolvedMasterId
  )}' in parents and trashed = false`;

  const searchUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(
    q
  )}&includeItemsFromAllDrives=true&supportsAllDrives=true&fields=files(id,name)&pageSize=5`;

  const res = await fetch(searchUrl, {
    headers: { Authorization: `Bearer ${params.accessToken}` },
  });
  if (!res.ok) return null;

  const data = (await res.json()) as { files?: { id: string; name: string }[] };
  return data.files && data.files.length > 0 ? data.files[0] : null;
}

/**
 * Renames a temporary `DA_REVISIONARE - <TaskCode>` subfolder in-place to `<Commessa> - <TaskCode>`
 * via Google Drive API v3 PATCH after explicit Admin confirmation during task review.
 */
export async function renameTaskDriveSubfolder(params: {
  accessToken: string;
  subfolderId: string;
  newCommessa: string;
  taskCode: string;
}): Promise<{
  subfolderId: string;
  newFolderPath: string;
  folderWebUrl: string;
}> {
  const newFolderPath = formatTaskDriveSubfolderName(
    params.newCommessa,
    params.taskCode
  );
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
    params.subfolderId
  )}?supportsAllDrives=true&fields=id,name`;

  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${params.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: newFolderPath }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(
      `Errore rinomina cartella Google Drive (${res.status}): ${errText}`
    );
  }

  const updated = (await res.json()) as { id: string; name?: string };
  const finalId = updated.id || params.subfolderId;
  return {
    subfolderId: finalId,
    newFolderPath: updated.name || newFolderPath,
    folderWebUrl: `https://drive.google.com/drive/folders/${finalId}`,
  };
}

/**
 * Removes a redundant direct file-level permission on `uploaderEmail` once `a.biagi@sitespa.it`
 * owns the file inside the shared task subfolder, while preserving inherited folder access.
 */
async function removeRedundantDirectUploaderPermission(
  accessToken: string,
  fileId: string,
  uploaderEmail?: string
): Promise<void> {
  const cleanUploader = (uploaderEmail || '').trim().toLowerCase();
  const masterLower = MASTER_DRIVE_OWNER_EMAIL.toLowerCase();
  if (!cleanUploader || cleanUploader === masterLower) return;

  try {
    const infoRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
        fileId
      )}?supportsAllDrives=true&fields=owners(emailAddress),permissions(id,emailAddress,role,permissionDetails)`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );
    if (!infoRes.ok) return;

    const info = (await infoRes.json()) as {
      owners?: { emailAddress?: string }[];
      permissions?: {
        id: string;
        emailAddress?: string;
        role?: string;
        permissionDetails?: { inherited?: boolean }[];
      }[];
    };

    const masterIsOwner = Boolean(
      info.owners?.some(
        (o) => (o.emailAddress || '').trim().toLowerCase() === masterLower
      )
    );
    if (!masterIsOwner) return;

    for (const perm of info.permissions || []) {
      const permEmail = (perm.emailAddress || '').trim().toLowerCase();
      if (permEmail !== cleanUploader || perm.role === 'owner') continue;
      const details = perm.permissionDetails || [];
      const hasDirect =
        details.length === 0 ||
        details.some((d) => d.inherited === false);
      const hasInherited = details.some((d) => d.inherited === true);

      // Only delete when inherited folder permission exists (or multiple permission entries exist) so folder access stays intact
      if (hasDirect && hasInherited) {
        await fetch(
          `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
            fileId
          )}/permissions/${encodeURIComponent(perm.id)}?supportsAllDrives=true`,
          {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${accessToken}` },
          }
        ).catch(() => undefined);
      }
    }
  } catch {
    // Non-blocking cleanup
  }
}

/**
 * Immediately initiates Google Drive ownership transfer to `a.biagi@sitespa.it` during photo upload:
 * 1. Calls `permissions.create` with `transferOwnership=true&supportsAllDrives=true&moveToNewOwnersRoot=false`.
 * 2. When immediate transfer succeeds (Workspace `@sitespa.it`), cleans redundant direct file permission on the uploader.
 * 3. When immediate transfer is blocked (e.g. external `@gmail.com` or two-step policy), immediately sets `pendingOwner: true`
 *    (with writer fallback) so ownership transfer is already queued in Google Drive the instant the upload finishes.
 */
async function attemptImmediateOwnershipTransfer(
  accessToken: string,
  fileId: string,
  uploaderEmail?: string
): Promise<boolean> {
  const cleanUploader = (uploaderEmail || '').trim().toLowerCase();
  const masterOwner = MASTER_DRIVE_OWNER_EMAIL.toLowerCase();
  if (cleanUploader === masterOwner) {
    return true;
  }

  try {
    const transferRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
        fileId
      )}/permissions?transferOwnership=true&supportsAllDrives=true&moveToNewOwnersRoot=false`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          type: 'user',
          role: 'owner',
          emailAddress: MASTER_DRIVE_OWNER_EMAIL,
        }),
      }
    );

    if (transferRes.ok) {
      await removeRedundantDirectUploaderPermission(
        accessToken,
        fileId,
        cleanUploader
      );
      return true;
    }

    // Verify if master owner already became owner despite response status
    const checkRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
        fileId
      )}?supportsAllDrives=true&fields=owners(emailAddress)`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    ).catch(() => null);
    if (checkRes && checkRes.ok) {
      const checkJson = (await checkRes.json()) as {
        owners?: { emailAddress?: string }[];
      };
      if (
        checkJson.owners?.some(
          (o) => (o.emailAddress || '').trim().toLowerCase() === masterOwner
        )
      ) {
        await removeRedundantDirectUploaderPermission(
          accessToken,
          fileId,
          cleanUploader
        );
        return true;
      }
    }

    // Start two-step pending ownership transfer immediately on Google Drive
    const pendingRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
        fileId
      )}/permissions?supportsAllDrives=true&sendNotificationEmail=false`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          type: 'user',
          role: 'writer',
          pendingOwner: true,
          emailAddress: MASTER_DRIVE_OWNER_EMAIL,
        }),
      }
    ).catch(() => null);

    if (!pendingRes || !pendingRes.ok) {
      await fetch(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
          fileId
        )}/permissions?supportsAllDrives=true&sendNotificationEmail=false`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            type: 'user',
            role: 'writer',
            emailAddress: MASTER_DRIVE_OWNER_EMAIL,
          }),
        }
      ).catch(() => undefined);
    }

    return false;
  } catch {
    return false;
  }
}

export async function uploadInterventionPhotoToDrive(params: {
  accessToken: string;
  file: File;
  masterFolderId?: string;
  commessa: string;
  taskCode: string;
  uploaderEmail?: string;
  preResolvedFolder?: ResolvedDriveTaskFolder;
  sequenceIndex?: number;
}): Promise<DriveUploadResult> {
  const {
    accessToken,
    file,
    masterFolderId,
    commessa,
    taskCode,
    uploaderEmail,
    preResolvedFolder,
    sequenceIndex,
  } = params;

  const resolved =
    preResolvedFolder ||
    (await ensureTaskDriveFolder({
      accessToken,
      masterFolderId,
      commessa,
      taskCode,
    }));

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const ext = file.name.includes('.')
    ? file.name.slice(file.name.lastIndexOf('.'))
    : '.jpg';
  const seqSuffix =
    typeof sequenceIndex === 'number'
      ? `_${String(sequenceIndex + 1).padStart(2, '0')}`
      : '';
  const finalFileName = `${taskCode}_${timestamp}${seqSuffix}${ext}`.slice(
    0,
    180
  );

  const commessaDesc = commessa.trim()
    ? `Commessa ${commessa.trim()}`
    : 'In attesa revisione commessa';
  const metadata = {
    name: finalFileName,
    parents: [resolved.taskFolderId],
    description: `Foto intervento ${taskCode} - ${commessaDesc}`,
  };

  const form = new FormData();
  form.append(
    'metadata',
    new Blob([JSON.stringify(metadata)], {
      type: 'application/json; charset=UTF-8',
    })
  );
  form.append('file', file);

  const uploadRes = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,webViewLink,thumbnailLink',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      body: form,
    }
  );

  if (!uploadRes.ok) {
    const errText = await uploadRes.text();
    throw new Error(
      `Errore caricamento foto su Google Drive (${uploadRes.status}): ${errText}`
    );
  }

  const uploaded = (await uploadRes.json()) as {
    id: string;
    name: string;
    webViewLink?: string;
    thumbnailLink?: string;
  };

  const ownerConsolidated = await attemptImmediateOwnershipTransfer(
    accessToken,
    uploaded.id,
    uploaderEmail
  );

  return {
    driveFileId: uploaded.id,
    fileName: uploaded.name || finalFileName,
    driveWebViewLink:
      uploaded.webViewLink ||
      `https://drive.google.com/file/d/${uploaded.id}/view`,
    driveThumbnailLink: uploaded.thumbnailLink || '',
    folderPath: resolved.folderPath,
    driveSubfolderId: resolved.taskFolderId,
    ownerConsolidated,
  };
}

export async function uploadMultipleInterventionPhotosToDrive(params: {
  accessToken: string;
  files: File[];
  masterFolderId?: string;
  commessa: string;
  taskCode: string;
  uploaderEmail?: string;
  onProgress?: (progress: BatchPhotoUploadProgress) => void;
  onFileUploaded?: (
    result: DriveUploadResult,
    file: File,
    index: number
  ) => Promise<void>;
}): Promise<{
  uploadedCount: number;
  failedFiles: { fileName: string; error: string }[];
}> {
  const {
    accessToken,
    files,
    masterFolderId,
    commessa,
    taskCode,
    uploaderEmail,
    onProgress,
    onFileUploaded,
  } = params;

  if (files.length === 0) {
    return { uploadedCount: 0, failedFiles: [] };
  }

  // Resolve centralized subfolder ONCE for the whole batch
  const resolvedFolder = await ensureTaskDriveFolder({
    accessToken,
    masterFolderId,
    commessa,
    taskCode,
  });

  let uploadedCount = 0;
  const failedFiles: { fileName: string; error: string }[] = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    onProgress?.({
      current: i + 1,
      total: files.length,
      fileName: file.name,
    });

    try {
      const result = await uploadInterventionPhotoToDrive({
        accessToken,
        file,
        masterFolderId,
        commessa,
        taskCode,
        uploaderEmail,
        preResolvedFolder: resolvedFolder,
        sequenceIndex: files.length > 1 ? i : undefined,
      });
      if (onFileUploaded) {
        await onFileUploaded(result, file, i);
      }
      uploadedCount += 1;
    } catch (err) {
      failedFiles.push({
        fileName: file.name,
        error: err instanceof Error ? err.message : 'Errore caricamento',
      });
    }
  }

  return { uploadedCount, failedFiles };
}

/**
 * Shares the master Google Drive folder (`1Ckkh1FQlZqjB8I8Aq-4ahSjDAva1ghLf`) as Editor (`writer`)
 * ONLY with legitimate Google Workspace accounts from Anagrafica (`@sitespa.it` or `nome.cognome.id@sitespa.it`).
 * - Operators already shared on the folder are recognized via `existingWriters` with zero API writes.
 * - Never shares with mail-only `@tecnicositespa.it` or non-Workspace addresses, and never sends external visitor invites.
 */
export async function syncMasterFolderEditorPermissions(params: {
  accessToken: string;
  masterFolderId?: string;
  targetEmails: string[];
}): Promise<{
  newlySharedEmails: string[];
  alreadySharedCount: number;
  failedEmails: { email: string; error: string }[];
}> {
  const folderId = extractDriveFolderId(
    params.masterFolderId || DEFAULT_DRIVE_SHARED_FOLDER_ID
  );
  const masterLower = MASTER_DRIVE_OWNER_EMAIL.toLowerCase();

  const desiredEmails = Array.from(
    new Set(
      params.targetEmails
        .map((e) => e.trim().toLowerCase())
        .filter((e) => isWorkspaceDriveEmail(e) && e !== masterLower)
    )
  );

  if (desiredEmails.length === 0) {
    return { newlySharedEmails: [], alreadySharedCount: 0, failedEmails: [] };
  }

  const listUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
    folderId
  )}/permissions?supportsAllDrives=true&fields=permissions(id,emailAddress,role,type)&pageSize=100`;

  const listRes = await fetch(listUrl, {
    headers: { Authorization: `Bearer ${params.accessToken}` },
  });

  if (!listRes.ok) {
    const errText = await listRes.text();
    throw new Error(
      `Impossibile leggere i permessi della cartella Drive (${listRes.status}): ${errText}`
    );
  }

  const listData = (await listRes.json()) as {
    permissions?: {
      id: string;
      emailAddress?: string;
      role?: string;
      type?: string;
    }[];
  };

  const existingWriters = new Set<string>();
  for (const perm of listData.permissions || []) {
    const em = (perm.emailAddress || '').trim().toLowerCase();
    if (
      em &&
      (perm.role === 'owner' ||
        perm.role === 'organizer' ||
        perm.role === 'fileOrganizer' ||
        perm.role === 'writer')
    ) {
      existingWriters.add(em);
    }
  }

  const newlySharedEmails: string[] = [];
  const failedEmails: { email: string; error: string }[] = [];
  let alreadySharedCount = 0;

  for (const email of desiredEmails) {
    if (existingWriters.has(email)) {
      alreadySharedCount += 1;
      continue;
    }

    const permUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
      folderId
    )}/permissions?supportsAllDrives=true&sendNotificationEmail=false`;

    const grantRes = await fetch(permUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'user',
        role: 'writer',
        emailAddress: email,
      }),
    });

    if (grantRes.ok) {
      newlySharedEmails.push(email);
    } else {
      const errText = await grantRes.text();
      failedEmails.push({ email, error: errText.slice(0, 160) });
    }
  }

  return { newlySharedEmails, alreadySharedCount, failedEmails };
}

export interface ConsolidatedPhotoOutcome {
  alreadyOwned: boolean;
  newDriveFileId: string;
  newFileName: string;
  newWebViewLink: string;
  newThumbnailLink: string;
  subfolderId: string;
  folderPath: string;
  supersededFileId: string;
}

/**
 * Executed automatically when `a.biagi@sitespa.it` accesses the app:
 * Copies external-uploaded photos inside the `<Commessa> - <TaskCode>` subfolder so the definitive
 * file is 100% owned by `a.biagi@sitespa.it`, detaches the external user's copy from the shared folder,
 * and marks `supersededFileId` so the external uploader can free their personal Drive storage in 1 tap.
 */
export async function consolidateExternalPhotosOwnership(params: {
  accessToken: string;
  masterFolderId?: string;
  pendingPhotos: InterventionPhoto[];
  taskCodeByTaskId: Map<string, string>;
  onPhotoConsolidated: (
    photo: InterventionPhoto,
    outcome: ConsolidatedPhotoOutcome
  ) => Promise<void>;
}): Promise<{ consolidatedCount: number; failedCount: number }> {
  const {
    accessToken,
    masterFolderId,
    pendingPhotos,
    taskCodeByTaskId,
    onPhotoConsolidated,
  } = params;

  const masterLower = MASTER_DRIVE_OWNER_EMAIL.toLowerCase();
  let consolidatedCount = 0;
  let failedCount = 0;

  for (const photo of pendingPhotos) {
    try {
      const metaRes = await fetch(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
          photo.driveFileId
        )}?supportsAllDrives=true&fields=id,name,parents,webViewLink,thumbnailLink,trashed,owners(emailAddress,me)`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        }
      );

      if (!metaRes.ok) {
        if (metaRes.status === 404) {
          continue;
        }
        failedCount += 1;
        continue;
      }

      const meta = (await metaRes.json()) as {
        id: string;
        name?: string;
        parents?: string[];
        webViewLink?: string;
        thumbnailLink?: string;
        trashed?: boolean;
        owners?: { emailAddress?: string; me?: boolean }[];
      };

      if (meta.trashed) {
        continue;
      }

      const isAlreadyOwnedByMaster = Boolean(
        meta.owners?.some(
          (o) =>
            o.me === true ||
            (o.emailAddress || '').trim().toLowerCase() === masterLower
        )
      );

      if (isAlreadyOwnedByMaster) {
        await removeRedundantDirectUploaderPermission(
          accessToken,
          photo.driveFileId,
          photo.technicianEmail
        );
        await onPhotoConsolidated(photo, {
          alreadyOwned: true,
          newDriveFileId: photo.driveFileId,
          newFileName: meta.name || photo.fileName,
          newWebViewLink: meta.webViewLink || photo.driveWebViewLink,
          newThumbnailLink: meta.thumbnailLink || photo.driveThumbnailLink,
          subfolderId: photo.driveSubfolderId || meta.parents?.[0] || '',
          folderPath: photo.folderPath,
          supersededFileId: '',
        });
        consolidatedCount += 1;
        continue;
      }

      // First try accepting pendingOwner in-place as a.biagi@sitespa.it (zero file copy, zero personal quota left on uploader)
      const acceptTransferRes = await fetch(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
          photo.driveFileId
        )}/permissions?transferOwnership=true&supportsAllDrives=true&moveToNewOwnersRoot=false`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            type: 'user',
            role: 'owner',
            emailAddress: MASTER_DRIVE_OWNER_EMAIL,
          }),
        }
      ).catch(() => null);

      if (acceptTransferRes && acceptTransferRes.ok) {
        await removeRedundantDirectUploaderPermission(
          accessToken,
          photo.driveFileId,
          photo.technicianEmail
        );
        await onPhotoConsolidated(photo, {
          alreadyOwned: true,
          newDriveFileId: photo.driveFileId,
          newFileName: meta.name || photo.fileName,
          newWebViewLink: meta.webViewLink || photo.driveWebViewLink,
          newThumbnailLink: meta.thumbnailLink || photo.driveThumbnailLink,
          subfolderId: photo.driveSubfolderId || meta.parents?.[0] || '',
          folderPath: photo.folderPath,
          supersededFileId: '',
        });
        consolidatedCount += 1;
        continue;
      }

      // Resolve target subfolder inside master folder
      let targetSubfolderId = photo.driveSubfolderId || meta.parents?.[0] || '';
      let targetFolderPath = photo.folderPath;

      if (!targetSubfolderId) {
        const taskCode =
          taskCodeByTaskId.get(photo.taskId) || `TASK_${photo.commessa}`;
        const resolved = await ensureTaskDriveFolder({
          accessToken,
          masterFolderId,
          commessa: photo.commessa,
          taskCode,
        });
        targetSubfolderId = resolved.taskFolderId;
        targetFolderPath = resolved.folderPath;
      }

      // Copy file as a.biagi@sitespa.it -> newly created file is 100% owned by a.biagi@sitespa.it
      const copyRes = await fetch(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
          photo.driveFileId
        )}/copy?supportsAllDrives=true&fields=id,name,webViewLink,thumbnailLink`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            name: photo.fileName,
            parents: [targetSubfolderId],
            description: `Foto intervento ${
              photo.commessa.trim()
                ? `Commessa ${photo.commessa.trim()}`
                : 'In attesa revisione commessa'
            } (proprietà consolidata ${MASTER_DRIVE_OWNER_EMAIL})`,
          }),
        }
      );

      if (!copyRes.ok) {
        failedCount += 1;
        continue;
      }

      const copied = (await copyRes.json()) as {
        id: string;
        name?: string;
        webViewLink?: string;
        thumbnailLink?: string;
      };

      // Immediately detach the uploader's superseded copy from the shared subfolder so no duplicate remains in the folder
      if (meta.parents && meta.parents.length > 0) {
        await fetch(
          `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
            photo.driveFileId
          )}?removeParents=${encodeURIComponent(
            meta.parents.join(',')
          )}&supportsAllDrives=true`,
          {
            method: 'PATCH',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({}),
          }
        ).catch(() => undefined);
      }

      await onPhotoConsolidated(photo, {
        alreadyOwned: false,
        newDriveFileId: copied.id,
        newFileName: copied.name || photo.fileName,
        newWebViewLink:
          copied.webViewLink ||
          `https://drive.google.com/file/d/${copied.id}/view`,
        newThumbnailLink: copied.thumbnailLink || '',
        subfolderId: targetSubfolderId,
        folderPath: targetFolderPath,
        supersededFileId: photo.driveFileId,
      });

      consolidatedCount += 1;
    } catch {
      failedCount += 1;
    }
  }

  return { consolidatedCount, failedCount };
}

/**
 * Deletes the external uploader's superseded temporary Drive copies ONLY after explicit user confirmation,
 * freeing 100% of their personal Google Drive storage quota.
 */
export async function deleteUploaderSupersededDriveFiles(params: {
  accessToken: string;
  photosToClean: InterventionPhoto[];
  onPhotoCleaned: (photoId: string) => Promise<void>;
}): Promise<{ deletedCount: number; failedCount: number }> {
  const { accessToken, photosToClean, onPhotoCleaned } = params;
  let deletedCount = 0;
  let failedCount = 0;

  for (const photo of photosToClean) {
    const fileId = (photo.pendingCleanupFileId || '').trim();
    if (!fileId) continue;

    try {
      const delRes = await fetch(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
          fileId
        )}?supportsAllDrives=true`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${accessToken}` },
        }
      );

      // 204 No Content or 404 Not Found (already removed) both clear the pending cleanup state
      if (delRes.ok || delRes.status === 404) {
        await onPhotoCleaned(photo.photoId);
        deletedCount += 1;
      } else {
        failedCount += 1;
      }
    } catch {
      failedCount += 1;
    }
  }

  return { deletedCount, failedCount };
}

export interface UnconfiguredIdTechInfo {
  name: string;
  loginEmail: string;
}

/**
 * Builds the structured Task Completion Summary Email for all active Admins (A:)
 * and the entire assigned technician squad including the closer (CC:),
 * resolving secondary deliverable emails for .id@sitespa.it login-only accounts.
 */
export function buildTaskCompletionEmailSummary(params: {
  task?: Task | null;
  completedByName: string;
  completedByReplyToEmail?: string;
  commessa: string;
  taskCode: string;
  descrizioneTask: string;
  inizioMs: number;
  fineMs: number;
  squadAssignments: Assignment[];
  overrideNoteByAssignmentId?: Record<string, string>;
  overrideNotesByEmail?: Record<string, string>;
  taskMaterials: UsedMaterial[];
  taskPhotos: InterventionPhoto[];
  activeAdminEmails: string[];
  resolveDeliverableEmail?: (email: string) => string;
  directory?: StaffMember[];
  masterFolderId?: string;
}): {
  to: string;
  cc: string;
  requiredCcCount: number;
  unconfiguredIdMembers: UnconfiguredIdTechInfo[];
  subject: string;
  bodyText: string;
  contextTitle: string;
  replyTo?: string;
  senderDisplayName?: string;
} {
  const {
    task,
    completedByName,
    completedByReplyToEmail,
    commessa,
    taskCode,
    descrizioneTask,
    inizioMs,
    fineMs,
    squadAssignments,
    overrideNoteByAssignmentId,
    overrideNotesByEmail,
    taskMaterials,
    taskPhotos,
    activeAdminEmails,
    resolveDeliverableEmail,
    directory,
    masterFolderId,
  } = params;

  const recipientList = Array.from(
    new Set(
      (activeAdminEmails.length > 0
        ? activeAdminEmails
        : task?.adminEmails && task.adminEmails.length > 0
        ? task.adminEmails
        : [...BOOTSTRAPPED_ADMIN_EMAILS]
      )
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean)
    )
  );

  // Resolve deliverable email for every canonical technician assigned to the task (including the person closing it)
  const squadRecipientByCanon = new Map<
    string,
    { canonKey: string; loginEmail: string; name: string; deliverableEmail: string }
  >();

  const pickBestDeliverable = (
    loginEmail: string,
    storedCandidate?: string
  ): string => {
    const cleanLogin = loginEmail.trim().toLowerCase();
    if (resolveDeliverableEmail && cleanLogin) {
      const live = resolveDeliverableEmail(cleanLogin).trim().toLowerCase();
      if (
        live &&
        VALIDATION_LIMITS.EMAIL_PATTERN.test(live) &&
        !isLoginOnlyIdEmail(live)
      ) {
        return live;
      }
    }
    const cleanStored = (storedCandidate || '').trim().toLowerCase();
    if (
      cleanStored &&
      VALIDATION_LIMITS.EMAIL_PATTERN.test(cleanStored) &&
      !isLoginOnlyIdEmail(cleanStored)
    ) {
      return cleanStored;
    }
    return cleanStored || cleanLogin;
  };

  const upsertSquadRecipient = (
    rawLoginEmail?: string,
    rawName?: string,
    rawDeliverable?: string
  ) => {
    const cleanLogin = (rawLoginEmail || '').trim().toLowerCase();
    const canon = canonicalTechnicianKey(cleanLogin, directory);
    if (!cleanLogin || !canon) return;
    const candidateName = (rawName || '').trim();
    const bestDeliv = pickBestDeliverable(cleanLogin, rawDeliverable);
    const existing = squadRecipientByCanon.get(canon);
    if (!existing) {
      squadRecipientByCanon.set(canon, {
        canonKey: canon,
        loginEmail: cleanLogin,
        name: candidateName || cleanLogin,
        deliverableEmail: bestDeliv,
      });
    } else {
      if (
        candidateName &&
        !candidateName.includes('@') &&
        (existing.name === existing.loginEmail || existing.name.includes('@'))
      ) {
        existing.name = candidateName;
      }
      if (
        isLoginOnlyIdEmail(existing.deliverableEmail) &&
        !isLoginOnlyIdEmail(bestDeliv)
      ) {
        existing.deliverableEmail = bestDeliv;
      }
    }
  };

  if (task) {
    const maxLen = Math.max(
      task.assignedEmails.length,
      task.assignedNames.length
    );
    for (let i = 0; i < maxLen; i++) {
      upsertSquadRecipient(
        task.assignedEmails[i],
        task.assignedNames[i],
        task.assignedDeliverableEmails?.[i]
      );
    }
  }

  for (const asg of squadAssignments) {
    if (asg.stato === 'Annullato') continue;
    const sqEmails = asg.squadEmails || [];
    const sqNames = asg.squadNames || [];
    const sqDeliv = asg.squadDeliverableEmails || [];
    if (!task && sqEmails.length > 0 && sqEmails.length === sqNames.length) {
      for (let i = 0; i < sqEmails.length; i++) {
        upsertSquadRecipient(sqEmails[i], sqNames[i], sqDeliv[i]);
      }
    }
    const ownLogin = asg.technicianEmail.trim().toLowerCase();
    const ownTaskIdx = task
      ? task.assignedEmails.findIndex((em) =>
          areSameTechnicianEmails(em, ownLogin, directory)
        )
      : -1;
    upsertSquadRecipient(
      ownLogin,
      asg.technicianName,
      ownTaskIdx >= 0 ? task?.assignedDeliverableEmails?.[ownTaskIdx] : undefined
    );
  }

  const squadEntries = Array.from(squadRecipientByCanon.values());
  const ccList = Array.from(
    new Set(squadEntries.map((e) => e.deliverableEmail).filter(Boolean))
  );
  const unconfiguredIdMembers: UnconfiguredIdTechInfo[] = squadEntries
    .filter((e) => isLoginOnlyIdEmail(e.deliverableEmail))
    .map((e) => ({
      name: e.name,
      loginEmail: e.loginEmail,
    }));

  const squadNames =
    task && task.assignedNames.length > 0
      ? task.assignedNames.join(', ')
      : squadEntries.map((e) => e.name).join(', ') || completedByName;

  const activeSquadAsgByCanon = new Map<string, Assignment>();
  for (const asg of squadAssignments) {
    if (asg.stato === 'Annullato') continue;
    const canon = canonicalTechnicianKey(asg.technicianEmail, directory);
    if (canon) activeSquadAsgByCanon.set(canon, asg);
  }

  const findOverrideNoteForCanon = (canonKey: string): string | undefined => {
    if (!overrideNotesByEmail) return undefined;
    for (const [rawEm, noteVal] of Object.entries(overrideNotesByEmail)) {
      if (canonicalTechnicianKey(rawEm, directory) === canonKey) {
        return noteVal;
      }
    }
    return undefined;
  };

  const notesLines =
    squadEntries.length > 0
      ? squadEntries
          .map((entry) => {
            const matchedAsg = activeSquadAsgByCanon.get(entry.canonKey);
            const taskIdx = task
              ? task.assignedEmails.findIndex((e) =>
                  areSameTechnicianEmails(e, entry.loginEmail, directory)
                )
              : -1;
            const fromEmailOverride = findOverrideNoteForCanon(entry.canonKey);
            const fromAsgOverride =
              matchedAsg &&
              overrideNoteByAssignmentId &&
              overrideNoteByAssignmentId[matchedAsg.assignmentId] !== undefined
                ? overrideNoteByAssignmentId[matchedAsg.assignmentId]
                : undefined;
            const fromTaskNotes =
              taskIdx >= 0 ? task?.assignedNotes?.[taskIdx] : undefined;
            const rawNote =
              fromEmailOverride !== undefined
                ? fromEmailOverride
                : fromAsgOverride !== undefined
                ? fromAsgOverride
                : matchedAsg?.noteTecnico || fromTaskNotes || '';
            const cleanNote = rawNote.trim() || 'Nessuna nota inserita';
            return `• ${entry.name}: ${cleanNote}`;
          })
          .join('\n')
      : squadAssignments.length > 0
      ? squadAssignments
          .map((asg) => {
            const rawNote =
              overrideNoteByAssignmentId &&
              overrideNoteByAssignmentId[asg.assignmentId] !== undefined
                ? overrideNoteByAssignmentId[asg.assignmentId]
                : asg.noteTecnico;
            const cleanNote = (rawNote || '').trim() || 'Nessuna nota inserita';
            return `• ${asg.technicianName}: ${cleanNote}`;
          })
          .join('\n')
      : '• Nessuna nota inserita';

  const materialsLines =
    taskMaterials.length > 0
      ? taskMaterials
          .map(
            (m) =>
              `• ${m.quantita} ${m.unitaMisura} × ${m.codiceArticolo} — ${m.descrizioneArticolo} (${m.technicianName})`
          )
          .join('\n')
      : '• Nessun materiale utilizzato registrato';

  const firstSubfolderId = taskPhotos.find((p) => p.driveSubfolderId)
    ?.driveSubfolderId;
  const resolvedMasterId = extractDriveFolderId(
    masterFolderId || DEFAULT_DRIVE_SHARED_FOLDER_ID
  );
  const driveLink = firstSubfolderId
    ? `https://drive.google.com/drive/folders/${firstSubfolderId}`
    : resolvedMasterId
    ? `https://drive.google.com/drive/folders/${resolvedMasterId}`
    : DEFAULT_DRIVE_SHARED_FOLDER_URL;

  const displayCommessa = commessa.trim() || 'Altro AT';
  const displayFolder = formatTaskDriveSubfolderName(commessa, taskCode);
  const rawReplyTo = (completedByReplyToEmail || '').trim().toLowerCase();
  const cleanReplyTo =
    rawReplyTo && !isLoginOnlyIdEmail(rawReplyTo) ? rawReplyTo : '';

  const headerLines = [
    `Riepilogo Completamento Intervento — SITE`,
    `==================================================`,
    `Commessa: ${displayCommessa}`,
    `Codice Task: ${taskCode}`,
    `Stato Task: Completato`,
    `Chiuso da: ${completedByName}`,
    ...(cleanReplyTo ? [`Contatto Tecnico: ${cleanReplyTo}`] : []),
    `Data e Orario: ${formatDateIt(inizioMs)} · ${formatTimeIt(
      inizioMs
    )} – ${formatTimeIt(fineMs)}`,
    `Squadra Tecnici: ${squadNames}`,
  ];

  const bodyText = [
    ...headerLines,
    ``,
    `ATTIVITÀ ESEGUITA`,
    `${descrizioneTask}`,
    ``,
    `NOTE ATTIVITÀ INSERITE`,
    `${notesLines}`,
    ``,
    `RIEPILOGO MATERIALI UTILIZZATI (${taskMaterials.length} voci)`,
    `${materialsLines}`,
    ``,
    `DOCUMENTAZIONE FOTOGRAFICA GOOGLE DRIVE`,
    `• Foto caricate: ${taskPhotos.length}`,
    `• Cartella Drive: ${displayFolder}`,
    `• Link Archivio Drive: ${driveLink}`,
  ].join('\n');

  return {
    to: recipientList.join(', '),
    cc: ccList.join(', '),
    requiredCcCount: ccList.length,
    unconfiguredIdMembers,
    subject: `[Task Completato] ${taskCode} · ${descrizioneTask}`,
    contextTitle: `Chiusura Intervento ${taskCode} · Commessa ${displayCommessa}`,
    bodyText,
    ...(cleanReplyTo ? { replyTo: cleanReplyTo } : {}),
    senderDisplayName: completedByName,
  };
}

export interface OutboxPreviewItem {
  outboxId: string;
  subject: string;
  to: string[];
  cc: string[];
  senderDisplayName: string;
  createdAtIso: string;
  lastError: string;
}

export type EmailDeliveryChannel =
  | 'smtp_gmail'
  | 'gmail_api'
  | 'outbox_queue'
  | 'none';

export interface SmtpStatusInfo {
  configured: boolean;
  smtpConfigured?: boolean;
  smtpUsable?: boolean;
  smtpAuthRevoked?: boolean;
  smtpError?: string;
  gmailBackupEnabled?: boolean;
  gmailOwnerEmail?: string;
  ownerGmailBridgeActive?: boolean;
  host: string;
  port: number;
  secure: boolean;
  senderEmail: string;
  pendingOutboxCount?: number;
  pendingOutboxPreview?: OutboxPreviewItem[];
  runtimeEnv?: 'production' | 'development';
}

export class SmtpNotConfiguredError extends Error {
  readonly code = 'SMTP_NOT_CONFIGURED';
  constructor(message: string) {
    super(message);
    this.name = 'SmtpNotConfiguredError';
  }
}

export function formatEmailChannelLabel(channel?: string): string {
  switch (channel) {
    case 'smtp_gmail':
    case 'smtp_fallback':
      return `SMTP Google (${MASTER_DRIVE_OWNER_EMAIL})`;
    case 'gmail_api':
      return `API Gmail (${MASTER_DRIVE_OWNER_EMAIL})`;
    case 'outbox_queue':
      return 'Coda di sicurezza SITE';
    default:
      return 'Motore email SITE';
  }
}

export async function syncOwnerGmailTokenToServer(
  workspaceAccessToken: string | null
): Promise<void> {
  if (!auth.currentUser) return;
  await fetchApiJson<{ ok: boolean }>('/api/email/owner-token', {
    method: 'POST',
    body: {
      workspaceAccessToken: workspaceAccessToken || '',
    },
    maxRetries: 1,
  });
}

async function resolveWorkspaceTokenForEmailSend(options?: {
  interactiveIfOwner?: boolean;
}): Promise<string | undefined> {
  const currentEmail = (auth.currentUser?.email || '').trim().toLowerCase();
  if (!currentEmail) {
    return undefined;
  }

  if (currentEmail === MASTER_DRIVE_OWNER_EMAIL.toLowerCase()) {
    const existing = getAccessToken();
    if (existing) {
      void syncOwnerGmailTokenToServer(existing).catch(() => undefined);
      return existing;
    }
    if (options?.interactiveIfOwner === false) {
      return undefined;
    }
    try {
      const fresh = await ensureWorkspaceAccessToken();
      void syncOwnerGmailTokenToServer(fresh).catch(() => undefined);
      return fresh;
    } catch {
      return undefined;
    }
  }

  if (
    currentEmail.endsWith('@sitespa.it') &&
    !isLoginOnlyIdEmail(currentEmail)
  ) {
    return getAccessToken() || undefined;
  }

  return undefined;
}

export async function fetchSmtpStatus(
  forceRefresh = false
): Promise<SmtpStatusInfo> {
  const suffix = forceRefresh ? '?refresh=1' : '';
  return fetchApiJson<SmtpStatusInfo>(`/api/email/status${suffix}`, {
    method: 'GET',
    maxRetries: 2,
  });
}

export async function sendServerSmtpEmail(params: {
  to: string;
  cc?: string;
  subject: string;
  bodyText: string;
  senderDisplayName?: string;
  replyTo?: string;
}): Promise<{
  queued: boolean;
  channel: EmailDeliveryChannel;
  queueReason?: string;
}> {
  const cleanTo = params.to
    .split(/[,;]+/)
    .map((addr) => addr.trim().toLowerCase())
    .filter(Boolean);

  const cleanCc = (params.cc || '')
    .split(/[,;]+/)
    .map((addr) => addr.trim().toLowerCase())
    .filter(Boolean);

  if (cleanTo.length === 0) {
    throw new Error(
      'Inserire almeno un indirizzo email destinatario principale (A:).'
    );
  }

  const blockedLoginAddr = [...cleanTo, ...cleanCc].find((addr) =>
    isLoginOnlyIdEmail(addr)
  );
  if (blockedLoginAddr) {
    throw new Error(
      `Invio bloccato: l'indirizzo ${blockedLoginAddr} è un account di solo accesso (.id@sitespa.it) e non può ricevere email. Inserisci un recapito email valido.`
    );
  }

  const rawReplyTo = (params.replyTo || '').trim().toLowerCase();
  const cleanReplyTo =
    rawReplyTo && !isLoginOnlyIdEmail(rawReplyTo) ? rawReplyTo : undefined;

  const workspaceAccessToken = await resolveWorkspaceTokenForEmailSend({
    interactiveIfOwner: false,
  });

  const executeSend = (opts: {
    token?: string;
    skipGmailApi?: boolean;
  }) =>
    fetchApiJson<{
      ok: boolean;
      sent?: boolean;
      queued?: boolean;
      channel?: EmailDeliveryChannel;
      queueReason?: string;
    }>('/api/email/send', {
      method: 'POST',
      body: {
        to: cleanTo,
        cc: cleanCc,
        subject: params.subject,
        bodyText: params.bodyText,
        senderDisplayName: params.senderDisplayName,
        replyTo: cleanReplyTo,
        ...(opts.token ? { workspaceAccessToken: opts.token } : {}),
        ...(opts.skipGmailApi ? { skipGmailApi: true } : {}),
      },
    });

  try {
    const res = await executeSend({ token: workspaceAccessToken });
    return {
      queued: Boolean(res.queued),
      channel: res.channel || 'smtp_gmail',
      queueReason: res.queueReason,
    };
  } catch (err: unknown) {
    if (err instanceof ApiError && err.code === 'GMAIL_CONSENT_REQUIRED') {
      try {
        const upgradedToken = await ensureWorkspaceAccessToken({
          forceConsent: true,
        });
        void syncOwnerGmailTokenToServer(upgradedToken).catch(() => undefined);
        const retryRes = await executeSend({ token: upgradedToken });
        return {
          queued: Boolean(retryRes.queued),
          channel: retryRes.channel || 'gmail_api',
          queueReason: retryRes.queueReason,
        };
      } catch {
        const fallbackRes = await executeSend({ skipGmailApi: true });
        return {
          queued: Boolean(fallbackRes.queued),
          channel: fallbackRes.channel || 'outbox_queue',
          queueReason: fallbackRes.queueReason,
        };
      }
    }

    if (
      err instanceof ApiError &&
      (err.code === 'SMTP_NOT_CONFIGURED' || err.status === 503)
    ) {
      throw new SmtpNotConfiguredError(err.message);
    }
    throw err;
  }
}

export async function sendServerSmtpTestEmail(
  recipientEmail?: string
): Promise<{ recipient: string; channel: EmailDeliveryChannel }> {
  try {
    const payload = await fetchApiJson<{
      recipient?: string;
      channel?: EmailDeliveryChannel;
    }>('/api/email/test', {
      method: 'POST',
      body: {
        recipientEmail: recipientEmail?.trim().toLowerCase() || undefined,
      },
    });
    return {
      recipient: payload.recipient || recipientEmail || '',
      channel: payload.channel || 'smtp_gmail',
    };
  } catch (err: unknown) {
    if (
      err instanceof ApiError &&
      (err.code === 'SMTP_NOT_CONFIGURED' || err.status === 503)
    ) {
      throw new SmtpNotConfiguredError(err.message);
    }
    throw err;
  }
}

export async function flushPendingEmailOutbox(): Promise<{
  sentCount: number;
  failedCount: number;
  remainingCount: number;
  channelUsed: EmailDeliveryChannel;
  lastError?: string;
}> {
  const workspaceAccessToken = await resolveWorkspaceTokenForEmailSend({
    interactiveIfOwner: true,
  });

  const executeFlush = (opts: { token?: string; skipGmailApi?: boolean }) =>
    fetchApiJson<{
      ok: boolean;
      sentCount: number;
      failedCount: number;
      remainingCount: number;
      channelUsed: EmailDeliveryChannel;
      lastError?: string;
    }>('/api/email/outbox/flush', {
      method: 'POST',
      body: {
        ...(opts.token ? { workspaceAccessToken: opts.token } : {}),
        ...(opts.skipGmailApi ? { skipGmailApi: true } : {}),
      },
    });

  try {
    return await executeFlush({ token: workspaceAccessToken });
  } catch (err: unknown) {
    if (err instanceof ApiError && err.code === 'GMAIL_CONSENT_REQUIRED') {
      const upgradedToken = await ensureWorkspaceAccessToken({
        forceConsent: true,
      });
      void syncOwnerGmailTokenToServer(upgradedToken).catch(() => undefined);
      return await executeFlush({ token: upgradedToken });
    }
    throw err;
  }
}


