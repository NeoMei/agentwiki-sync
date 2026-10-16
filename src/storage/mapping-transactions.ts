import {
  isPullJournal,
  type PullJournal,
} from "../application/pull-transaction";
import {
  isTreeTransactionJournal,
  type TreeTransactionJournal,
} from "../application/tree-transaction";
import { isPullControlAfterState } from "../application/sync-runtime";
import { isV3PullControlAfterState } from "../application/tree-local-apply-v3";
import type { ControlStorePort } from "../ports/control-store";
import { isBaselineJournal } from "./baseline";
import { isTreeBaselineJournal } from "./tree-baseline";
import {
  PushJournalRouter,
  strictPushEnvelopeRead,
} from "./push-journal-router";
import {
  isUpgradeIntent,
  LocalImageUpgradeRepository,
} from "./local-image-upgrade";

/** Inspect locally, even when disconnected or a pending mapping has an old root. */
export async function assertNoRecoverableMappingTransaction(
  store: ControlStorePort,
  root: string,
): Promise<void> {
  const pending = (kind = "同步事务") => {
    throw new Error(`MAPPING_TRANSACTION_PENDING: 有未完成的${kind}`);
  };
  const upgrade = (
    await strictPushEnvelopeRead(
      store,
      `${root}/local-image-upgrade/journal.json`,
      isUpgradeIntent,
    )
  )?.payload;
  if (upgrade) {
    if (upgrade.phase !== "complete" && upgrade.phase !== "superseded")
      pending("图片同步升级");
    await new LocalImageUpgradeRepository(store, root, upgrade.binding).read();
  }
  const pull = (
    await strictPushEnvelopeRead(
      store,
      `${root}/pull/journal.json`,
      (value): value is PullJournal | TreeTransactionJournal =>
        isPullJournal(value) || isTreeTransactionJournal(value),
    )
  )?.payload;
  if (pull && pull.state !== "committed" && pull.state !== "rolled_back")
    pending();
  const legacy = (
    await strictPushEnvelopeRead(
      store,
      `${root}/baseline-journal.json`,
      isBaselineJournal,
    )
  )?.payload;
  const tree = (
    await strictPushEnvelopeRead(
      store,
      `${root}/tree-v2/baseline-journal.json`,
      isTreeBaselineJournal,
    )
  )?.payload;
  for (const journal of [legacy, tree])
    if (
      journal &&
      journal.phase !== "committed" &&
      journal.phase !== "rolled_back"
    )
      pending();
  const after = (
    await strictPushEnvelopeRead(
      store,
      `${root}/pull-control-after.json`,
      isPullControlAfterState,
    )
  )?.payload;
  const afterV3 = (
    await strictPushEnvelopeRead(
      store,
      `${root}/v3-pull-control-after.json`,
      isV3PullControlAfterState,
    )
  )?.payload;
  for (const journal of [after, afterV3])
    if (journal && journal.phase !== "applied") pending();
  const push = (await new PushJournalRouter(store, root).read())?.payload;
  if (
    push &&
    (push.schemaVersion === 4
      ? push.phase !== "complete" && push.phase !== "superseded"
      : push.remoteState !== "superseded" &&
        push.localCommitPhase !== "verified")
  )
    pending();
}
