// finalize re-exports finalizeStub from the stub-lib. Unlike the
// 6 simpler stubs (which use stubTask with a buildOutput callback),
// finalize has terminal-success Service/Job transitions that the
// stub-lib owns. PR-C.9 replaces this re-export with real logic.
export { finalizeStub as handler } from "@ironforge/workflow-stub-lib";
