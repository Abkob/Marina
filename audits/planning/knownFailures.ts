/** These are reproduced failures/primitive limitations, never repaired passes. */
export const knownPlanningBaselineFailures = [
  { id: 'CHAT-01', kind: 'defect', file: 'audits/copilot/conversation.test.ts', next: 'P01.1' },
  { id: 'RAG-02', kind: 'defect', file: 'audits/copilot/retrieval.test.ts', next: 'P06.1' },
  { id: 'VIS-01', kind: 'native-text limitation', file: 'audits/copilot/pdf.test.ts', next: 'P05.2' },
  { id: 'VIS-02', kind: 'native-text limitation', file: 'audits/copilot/pdf.test.ts', next: 'P05.2' },
] as const;

export function summarizeVitest(receipt: any, exitCode: number, expected: readonly { id: string }[] = []) {
  const assertions = (receipt.testResults ?? []).flatMap((file: any) => (file.assertionResults ?? []).map((test: any) => ({
    file: String(file.name ?? '').replaceAll('\\', '/').split('/Amina/').at(-1), name: test.fullName,
    status: test.status, duration_ms: test.duration ?? null,
  })));
  const expectedCases = assertions.filter((test: any) => expected.some(item => test.name?.includes(`${item.id} `)));
  const expectedIds = expected.map(item => item.id);
  const missing = expectedIds.filter(id => expectedCases.filter((test: any) => test.name.includes(`${id} `)).length !== 1);
  const failed = assertions.filter((test: any) => test.status === 'failed');
  const passed = assertions.filter((test: any) => test.status === 'passed');
  const skipped = assertions.filter((test: any) => test.status === 'pending' || test.status === 'skipped' || test.status === 'todo');
  const failedSuites = (receipt.testResults ?? []).filter((file: any) => file.status === 'failed').map((file: any) => String(file.name ?? '').replaceAll('\\', '/').split('/Amina/').at(-1));
  return { success: exitCode === 0 && receipt.success === true && failed.length === 0 && failedSuites.length === 0 && missing.length === 0,
    exit_code: exitCode, ordinary_passes: passed.length - expectedCases.filter((test: any) => test.status === 'passed').length,
    expected_failures: expectedCases, missing_expected_failures: missing, failed, failed_suites: failedSuites, skipped, tests: assertions };
}
