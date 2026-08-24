import type { CachedTransaction } from "../types.js";

export type RewardConfidence = "high" | "medium" | "low";
export type RewardExclusion =
  | "duplicate"
  | "fee-or-interest"
  | "missing-card"
  | "missing-date-or-amount"
  | "split-detail-unavailable"
  | "transfer-or-payment";

export interface RewardCategoryMatch {
  rewardCategory: string;
  confidence: RewardConfidence;
}

export interface RewardPurchaseComponent {
  amountCents: number;
  match?: RewardCategoryMatch;
}

export interface RewardClassificationSummary {
  cardKey: string;
  month: string;
  eligibleNetCents: number;
  purchaseCents: number;
  refundCents: number;
  purchaseCount: number;
  refundCount: number;
  categories: Array<{ rewardCategory: string; confidence: RewardConfidence; eligibleNetCents: number }>;
}

export interface RewardClassificationResult {
  summaries: RewardClassificationSummary[];
  exclusions: Array<{ reason: RewardExclusion; count: number; netCents: number }>;
  inputCount: number;
  uniqueCount: number;
  classificationCaveat: string;
}

const CLASSIFICATION_CAVEAT = "Simplifi categories are household labels; issuer merchant-category coding may differ.";
const NON_REWARD_CATEGORY = /(?:annual fee|cash advance|cash equivalent|cash-like|fee|finance charge|interest|late payment)/i;

/**
 * Classify cached card activity while keeping account ids, transaction ids, and
 * merchant text inside the private call boundary. Returned values are summaries.
 */
export function classifyCardPurchases(
  transactions: readonly CachedTransaction[],
  options: {
    cardKeyForAccount: (accountId: string) => string | undefined;
    merchantMatch?: (transaction: CachedTransaction) => RewardCategoryMatch | undefined;
    categoryMatch?: (transaction: CachedTransaction) => RewardCategoryMatch | undefined;
    splitComponents?: (transaction: CachedTransaction) => readonly RewardPurchaseComponent[] | undefined;
  },
): RewardClassificationResult {
  const seen = new Set<string>();
  const exclusions = new Map<RewardExclusion, { count: number; netCents: number }>();
  const summaries = new Map<string, RewardClassificationSummary & { categoryMap: Map<string, RewardClassificationSummary["categories"][number]> }>();

  const exclude = (reason: RewardExclusion, amountCents = 0) => {
    const current = exclusions.get(reason) ?? { count: 0, netCents: 0 };
    current.count += 1;
    current.netCents += amountCents;
    exclusions.set(reason, current);
  };

  for (const transaction of transactions) {
    if (seen.has(transaction.id)) {
      exclude("duplicate", transaction.amountCents ?? 0);
      continue;
    }
    seen.add(transaction.id);

    if (!transaction.accountId) {
      exclude("missing-card", transaction.amountCents ?? 0);
      continue;
    }
    const cardKey = options.cardKeyForAccount(transaction.accountId);
    if (!cardKey) {
      exclude("missing-card", transaction.amountCents ?? 0);
      continue;
    }
    if (!transaction.transactionDate || transaction.amountCents === undefined) {
      exclude("missing-date-or-amount", transaction.amountCents ?? 0);
      continue;
    }
    if (transaction.transfer || transaction.coa?.type === "ACCOUNT") {
      exclude("transfer-or-payment", transaction.amountCents);
      continue;
    }
    let components: readonly RewardPurchaseComponent[] = [{ amountCents: transaction.amountCents }];
    if (transaction.split?.items?.length) {
      // Cached split lines do not expose integer cents. A private adapter may
      // expand them; otherwise excluding the row is safer than inventing allocation.
      const expanded = options.splitComponents?.(transaction);
      if (!expanded?.length) {
        exclude("split-detail-unavailable", transaction.amountCents);
        continue;
      }
      components = expanded;
    }

    const month = transaction.transactionDate.slice(0, 7);
    const summaryKey = `${cardKey}\u0000${month}`;
    const summary = summaries.get(summaryKey) ?? {
      cardKey,
      month,
      eligibleNetCents: 0,
      purchaseCents: 0,
      refundCents: 0,
      purchaseCount: 0,
      refundCount: 0,
      categories: [],
      categoryMap: new Map(),
    };
    for (const component of components) {
      const category = component.match ?? options.merchantMatch?.(transaction) ?? options.categoryMatch?.(transaction);
      const categoryName = category?.rewardCategory ?? "unmapped";
      if (NON_REWARD_CATEGORY.test(categoryName)) {
        exclude("fee-or-interest", component.amountCents);
        continue;
      }

      const signedEligibleCents = -component.amountCents;
      summary.eligibleNetCents += signedEligibleCents;
      if (signedEligibleCents >= 0) {
        summary.purchaseCents += signedEligibleCents;
        summary.purchaseCount += 1;
      } else {
        summary.refundCents += Math.abs(signedEligibleCents);
        summary.refundCount += 1;
      }
      const confidence = category?.confidence ?? "low";
      const categoryKey = `${categoryName}\u0000${confidence}`;
      const categorySummary = summary.categoryMap.get(categoryKey) ?? { rewardCategory: categoryName, confidence, eligibleNetCents: 0 };
      categorySummary.eligibleNetCents += signedEligibleCents;
      summary.categoryMap.set(categoryKey, categorySummary);
    }
    if (summary.purchaseCount > 0 || summary.refundCount > 0) summaries.set(summaryKey, summary);
  }

  return {
    summaries: [...summaries.values()].map(({ categoryMap, ...summary }) => ({
      ...summary,
      categories: [...categoryMap.values()].sort((left, right) => left.rewardCategory.localeCompare(right.rewardCategory)),
    })).sort((left, right) => left.month.localeCompare(right.month) || left.cardKey.localeCompare(right.cardKey)),
    exclusions: [...exclusions].map(([reason, value]) => ({ reason, ...value })).sort((left, right) => left.reason.localeCompare(right.reason)),
    inputCount: transactions.length,
    uniqueCount: seen.size,
    classificationCaveat: CLASSIFICATION_CAVEAT,
  };
}
