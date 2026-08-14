import { describe, expect, it, vi } from 'vitest';
import type {
  DocumentSaveResponse,
  FileVersion,
  MutationOutcome,
  PreparedOpenFileResponse,
  DeleteWorkspaceEntryResponse,
} from '../types';
import {
  PACKAGED_LIFECYCLE_COMPETING_CONTENT,
  PACKAGED_LIFECYCLE_CONTROL_GO,
  PACKAGED_LIFECYCLE_CONTROL_READY,
  decodePackagedLifecycleE2eSetup,
  runPackagedLifecycleE2e,
  startPackagedLifecycleE2e,
  type PackagedLifecycleE2ePorts,
  type PackagedLifecycleE2eSetup,
} from './packagedLifecycleE2e';

const version = (path: string, revision: number): FileVersion => ({
  canonicalPath: path,
  platformIdentity: `identity-${revision}`,
  length: String(revision),
  modifiedNanos: String(revision),
  sha256: revision.toString(16).padStart(64, '0'),
});

const setup: PackagedLifecycleE2eSetup = {
  schema: 1,
  nonce: '1'.repeat(64),
  workflow: {
    run_id: '123',
    run_attempt: '2',
    commit: 'a'.repeat(40),
    target: 'aarch64-apple-darwin',
  },
  package_variant: 'app',
  current_exe_sha256: 'b'.repeat(64),
  workspace: {
    workspace_token: 'workspace-token',
    root: '/fixture',
    files: [],
    directories: [],
  },
  paths: {
    save_success: '/fixture/save-success.md',
    save_stale: '/fixture/save-stale.md',
    control: '/fixture/control.md',
    trash_file: '/fixture/trash-file.md',
    trash_directory: '/fixture/trash-dir',
    receipt: '/fixture/receipt.md',
  },
};

function sha256(content: string): string {
  const values: Record<string, string> = {
    '': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    ['1'.repeat(64)]: '3138bb9bc78df27c473ecfd1410f7bd45ebac1f59cf3ff9cfe4db77aab7aedd3',
    'original success': '279a96060d2cb6ab401865a71ddb9eb4387f4ca7601fbbfa57fc79b459065b57',
    'packaged lifecycle saved\n': 'cf7194bcbfec5036295e0aea188b3ccf8a27cb805bdaaa2b76f78adefe913d09',
    'original stale': 'cb6a45393bcdf4b48d8d29c71ad91a62a086e77898bba1340bc388581ac231bd',
    'external competing bytes\n': '7b63b1094fd96d64123b59f7560726c666ce0d568e1a4c3bc34b50a41f53aed6',
    waiting: '80cfa3e7f28dde4df64436b652230aff28d7779116d1369c21ef2bbf37261d71',
    'go\n': 'c2fc355f2b52e01ea670dc8b27f1c8f3a268d68b4b399a0cf91544cb975792df',
  };
  const value = values[content];
  if (!value) throw new Error(`missing fixture digest: ${JSON.stringify(content)}`);
  return value;
}

function prepared(path: string, content: string, revision: number): PreparedOpenFileResponse {
  return {
    file: {
      kind: 'markdown',
      path,
      content_mode: 'text',
      content,
      file_version: { ...version(path, revision), length: String(content.length), sha256: sha256(content) },
    },
    open_receipt: `open-${path}-${revision}`,
    commit_operation_id: `commit-${path}-${revision}`,
  };
}

function committedSave(path: string, revision: number): DocumentSaveResponse {
  return { status: 'confirmed_committed', path, version: version(path, revision) };
}

function committedDelete(path: string): MutationOutcome<DeleteWorkspaceEntryResponse> {
  return {
    status: 'confirmed-committed',
    receipt: {
      committed: { deleted_path: path },
      workspace: { status: 'not-applicable' },
    },
  };
}

function createPorts(): PackagedLifecycleE2ePorts {
  let controlReads = 0;
  let successSaved = false;
  const openWorkspaceFile = vi.fn<PackagedLifecycleE2ePorts['openWorkspaceFile']>(async (path: string) => {
    if (path === setup.paths.save_success) {
      return prepared(path, successSaved ? 'packaged lifecycle saved\n' : 'original success', successSaved ? 8 : 1);
    }
    if (path === setup.paths.save_stale) {
      return prepared(
        path,
        controlReads >= 2 ? PACKAGED_LIFECYCLE_COMPETING_CONTENT : 'original stale',
        controlReads >= 2 ? 9 : 2,
      );
    }
    if (path === setup.paths.control) {
      controlReads += 1;
      return prepared(path, controlReads >= 2 ? PACKAGED_LIFECYCLE_CONTROL_GO : 'waiting', 3 + controlReads);
    }
    if (path === setup.paths.receipt) return prepared(path, '', 7);
    throw new Error(`unexpected open: ${path}`);
  });
  const writeFile = vi.fn<PackagedLifecycleE2ePorts['writeFile']>(async (path: string, content: string) => {
    if (path === setup.paths.save_success) {
      successSaved = true;
      return {
        ...committedSave(path, 8),
        version: { ...version(path, 8), length: String(content.length), sha256: sha256(content) },
      };
    }
    if (path === setup.paths.control && content === PACKAGED_LIFECYCLE_CONTROL_READY) {
      return committedSave(path, 9);
    }
    if (path === setup.paths.save_stale) {
      return {
        status: 'conflict' as const,
        path,
        current_version: version(path, 9),
        message: 'stale version',
      };
    }
    if (path === setup.paths.receipt) return committedSave(path, 10);
    throw new Error(`unexpected write: ${path}`);
  });
  return {
    setup: vi.fn<PackagedLifecycleE2ePorts['setup']>().mockResolvedValue(setup),
    openWorkspaceFile,
    commitRecentOpen: vi.fn<PackagedLifecycleE2ePorts['commitRecentOpen']>()
      .mockResolvedValue({ status: 'committed', recent_files: { entries: [] } }),
    getOpenCommitStatus: vi.fn<PackagedLifecycleE2ePorts['getOpenCommitStatus']>().mockResolvedValue({
      status: 'committed',
      recent_files: { entries: [] },
    }),
    writeFile,
    deleteWorkspaceEntry: vi.fn<PackagedLifecycleE2ePorts['deleteWorkspaceEntry']>(
      async (_workspaceToken, path) => committedDelete(path),
    ),
    wait: vi.fn<PackagedLifecycleE2ePorts['wait']>().mockResolvedValue(undefined),
    close: vi.fn<PackagedLifecycleE2ePorts['close']>().mockResolvedValue(undefined),
  };
}

describe('packaged lifecycle E2E runner', () => {
  it('decodes the exact nested workflow identity', () => {
    expect(decodePackagedLifecycleE2eSetup(setup)).toEqual(setup);
  });

  it('drives save, stale CAS, native Trash, and receipt writes through production ports', async () => {
    const ports = createPorts();

    const receipt = await runPackagedLifecycleE2e(ports);

    expect(receipt).toMatchObject({
      schema: 2,
      gate: 'packaged-lifecycle-e2e',
      status: 'passed',
      target: setup.workflow.target,
      runId: setup.workflow.run_id,
      runAttempt: setup.workflow.run_attempt,
      commit: setup.workflow.commit,
      buildFlavor: 'ci-instrumented-packaged-e2e',
      instrumentationFeature: 'packaged-lifecycle-e2e',
      packageVariant: setup.package_variant,
      currentExeSha256: setup.current_exe_sha256,
      nonceDigest: sha256(setup.nonce),
      saveSuccess: {
        response: 'confirmed_committed',
        exactBytes: true,
      },
      staleCas: { response: 'conflict', externalBytesPreserved: true },
      trash: [
        { kind: 'file', response: 'confirmed-committed', sourceAbsent: true },
        { kind: 'non-empty-directory', response: 'confirmed-committed', sourceAbsent: true },
      ],
    });
    expect(ports.writeFile).toHaveBeenCalledWith(
      setup.paths.save_stale,
      expect.any(String),
      expect.objectContaining({
        canonicalPath: setup.paths.save_stale,
        platformIdentity: 'identity-2',
        sha256: sha256('original stale'),
      }),
      expect.any(String),
    );
    expect(ports.deleteWorkspaceEntry).toHaveBeenNthCalledWith(
      1,
      setup.workspace.workspace_token,
      setup.paths.trash_file,
    );
    expect(ports.deleteWorkspaceEntry).toHaveBeenNthCalledWith(
      2,
      setup.workspace.workspace_token,
      setup.paths.trash_directory,
    );
    const receiptWrite = vi.mocked(ports.writeFile).mock.calls.find(([path]) => path === setup.paths.receipt);
    expect(JSON.parse(receiptWrite?.[1] ?? '')).toEqual(receipt);
    expect(receiptWrite?.[1]).not.toContain('/fixture');
    expect(receiptWrite?.[1]).not.toContain(PACKAGED_LIFECYCLE_COMPETING_CONTENT.trim());
    expect(ports.commitRecentOpen).toHaveBeenCalledTimes(7);
  });

  it('retries a definitively failed control poll open after atomic replacement', async () => {
    const ports = createPorts();
    let rejectedReplacement = false;
    vi.mocked(ports.commitRecentOpen).mockImplementation(async (openReceipt) => {
      if (!rejectedReplacement && openReceipt === `open-${setup.paths.control}-5`) {
        rejectedReplacement = true;
        return { status: 'not_committed', message: 'transient recent-store contention' };
      }
      return { status: 'committed', recent_files: { entries: [] } };
    });

    await expect(runPackagedLifecycleE2e(ports)).resolves.toMatchObject({ status: 'passed' });

    expect(rejectedReplacement).toBe(true);
    expect(ports.wait).toHaveBeenCalled();
  });

  it('rejects malformed setup identities before they can become evidence', () => {
    expect(() => decodePackagedLifecycleE2eSetup({ ...setup, nonce: '../fixture' })).toThrow(
      'Invalid packaged lifecycle setup: nonce',
    );
    expect(() => decodePackagedLifecycleE2eSetup({ ...setup, current_exe_sha256: 'not-a-digest' })).toThrow(
      'Invalid packaged lifecycle setup: current_exe_sha256',
    );
    const { workflow: _workflow, ...setupWithoutWorkflow } = setup;
    expect(() =>
      decodePackagedLifecycleE2eSetup({
        ...setupWithoutWorkflow,
        run_id: setup.workflow.run_id,
        run_attempt: setup.workflow.run_attempt,
        commit: setup.workflow.commit,
        target: setup.workflow.target,
      }),
    ).toThrow('Invalid packaged lifecycle setup: workflow');
    expect(() =>
      decodePackagedLifecycleE2eSetup({
        ...setup,
        workflow: { ...setup.workflow, unexpected: 'identity' },
      }),
    ).toThrow('Invalid packaged lifecycle setup: workflow');
    expect(() =>
      decodePackagedLifecycleE2eSetup({
        ...setup,
        workflow: { ...setup.workflow, run_attempt: '' },
      }),
    ).toThrow('Invalid packaged lifecycle setup: run_attempt');
  });

  it('writes a failed receipt and closes the packaged window when a gate fails', async () => {
    const ports = createPorts();
    vi.mocked(ports.deleteWorkspaceEntry).mockResolvedValueOnce({
      status: 'confirmed-not-committed',
      message: 'trash unavailable',
    });

    await startPackagedLifecycleE2e(ports);

    const receiptWrites = vi.mocked(ports.writeFile).mock.calls.filter(([path]) => path === setup.paths.receipt);
    expect(receiptWrites).toHaveLength(1);
    expect(JSON.parse(receiptWrites[0]![1])).toMatchObject({
      schema: 2,
      gate: 'packaged-lifecycle-e2e',
      status: 'failed',
      error: 'trash unavailable',
      nonceDigest: sha256(setup.nonce),
    });
    expect(ports.close).toHaveBeenCalledOnce();
  });
});
