export interface MetaData {
  asOf?: string;
  currentPage?: number;
  lastRefId?: string;
  limit?: number;
  nextLink?: string;
  offset?: number;
  pageSize?: number;
  totalPages?: number;
  totalSize?: number;
  [key: string]: unknown;
}

export interface Category {
  id?: string;
  parentId?: string;
  categoryType?: string;
  usageType?: string;
  name?: string;
  description?: string;
  createdAt?: string;
  modifiedAt?: string;
  isBusiness?: boolean;
  isInvestment?: boolean;
  isNotEditable?: boolean;
  isNotUserAssignable?: boolean;
  isExcludedFromBudgets?: boolean;
  isExcludedFromCategoryList?: boolean;
  isExcludedFromReports?: boolean;
  [key: string]: unknown;
}

export interface Tag {
  id?: string;
  name?: string;
  type?: string;
  createdAt?: string;
  modifiedAt?: string;
  userModifiedAt?: string;
  numberOfUses?: number;
  [key: string]: unknown;
}

export interface CoaRef {
  type?: string;
  id?: string;
  [key: string]: unknown;
}

/**
 * Data the connected provider supplied, as distinct from what Simplifi derived.
 *
 * Only the fields the code depends on are named; the rest stay in the index
 * signature. `txnOn` matters most: it is the date the transaction occurred,
 * which can differ from the `postedOn` settlement date.
 */
export interface ConnectedProviderData {
  /** Transaction date, `YYYY-MM-DD`, when supplied by the connected provider. */
  txnOn?: string;
  postedOn?: string;
  [key: string]: unknown;
}

/**
 * Link to the other leg of a transfer between two of our own accounts.
 *
 * `id` is the counterpart **transaction's** id, not a shared pair key.
 */
export interface TransferRef {
  id?: string;
  [key: string]: unknown;
}

/**
 * One line of a split transaction.
 *
 * `amount` is deliberately **not** named here. It arrives as a decimal, and
 * naming it would bless a float on a type this project hands to callers. Reading
 * split amounts as money is SUD-15's job, and it converts them at the boundary
 * the way every other amount is converted. The analysis layer needs only whether
 * a split exists, because a split row can carry no top-level `coa` and therefore
 * cannot be attributed to a category without opening its lines.
 */
export interface TransactionSplitItem {
  coa?: CoaRef;
  memo?: string;
  [key: string]: unknown;
}

export interface TransactionSplit {
  items?: TransactionSplitItem[];
  [key: string]: unknown;
}

export interface Transaction {
  id: string;
  cpData?: ConnectedProviderData;
  transfer?: TransferRef;
  split?: TransactionSplit;
  clientId?: string;
  userModifiedAt?: string;
  createdAt?: string;
  modifiedAt?: string;
  dbVersion?: number;
  source?: string;
  accountId?: string;
  postedOn?: string;
  payee?: string;
  renamedPayee?: string;
  memo?: string;
  coa?: CoaRef;
  amount?: number;
  state?: string;
  matchState?: string;
  type?: string;
  knownCategoryId?: string;
  mlInferredPayee?: string;
  isDeleted?: boolean;
  [key: string]: unknown;
}

export interface TransactionListResponse {
  metaData: MetaData;
  resources: Transaction[];
}

export interface CategoryListResponse {
  metaData: MetaData;
  resources: Category[];
}

export interface TagListResponse {
  metaData: MetaData;
  resources: Tag[];
}

export interface EarliestDateOnResponse {
  dateOn: string;
  [key: string]: unknown;
}

// TransactionMutationResponse removed with the write surface: nothing in this
// codebase can produce a mutation, so nothing needs a type for its response.

export interface SimplifiTokenSet {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt?: string;
}

export interface SimplifiTokenRow extends SimplifiTokenSet {
  updatedAt: string;
}

export interface SyncState {
  id: number;
  dateOnAfter?: string;
  lastAsOf?: string;
  lastFullSyncAt?: string;
  lastSyncAt?: string;
  syncStatus?: string;
  lastError?: string;
}

export interface TransactionFilters {
  accountId?: string;
  dateFrom?: string;
  dateTo?: string;
  minAmount?: number;
  maxAmount?: number;
  includeDeleted?: boolean;
}

/**
 * An account as Simplifi sends it. Money fields are decimals here and stay that
 * way until the write boundary converts them; see src/money.ts.
 *
 * Statement fields appear only on credit accounts, and not on all of them, so
 * they are optional in the strongest sense: absent is normal, not an error.
 */
export interface Account {
  id: string;
  name?: string;
  /** INVESTMENT, CREDIT, BANK, LOAN, VEHICLE, REAL_ESTATE. */
  type?: string;
  subType?: string;
  usageType?: string;
  currency?: string;
  isClosed?: boolean;
  isIgnored?: boolean;
  isConnected?: boolean;
  balanceAsOf?: number;
  balanceAsOfOn?: string;
  currentBalanceAsOf?: number;
  currentBalanceAsOfOn?: string;
  onlineBalance?: number;
  creditLimit?: number;
  interestRate?: number;
  statementDueAt?: string;
  statementDueAmount?: number;
  statementMinPayment?: number;
  statementPastDueAmount?: number;
  statementCloseAt?: string;
  statementCloseBalance?: number;
  statementLastPaymentAmount?: number;
  statementLastPaymentAt?: string;
  normalizedBalance?: number;
  goalBalance?: number;
  modifiedAt?: string;
  [key: string]: unknown;
}

export interface AccountListResponse {
  metaData: MetaData;
  resources: Account[];
}

export interface ScheduledRecurrence {
  frequency?: string;
  interval?: number;
  byMonthDay?: number;
  [key: string]: unknown;
}

/**
 * The transaction a scheduled entry will create when it comes due. Shares the
 * shape of a real transaction but is not one — it has no id of its own.
 */
export interface ScheduledTransactionDetail {
  accountId?: string;
  payee?: string;
  amount?: number;
  coa?: CoaRef;
  isBill?: boolean;
  isSubscription?: boolean;
  [key: string]: unknown;
}

export interface ScheduledTransaction {
  id: string;
  /** BILL, SUBSCRIPTION, TRANSFER. */
  type?: string;
  dueOn?: string;
  lastDueOn?: string;
  isCompleted?: boolean;
  recurrence?: ScheduledRecurrence;
  transaction?: ScheduledTransactionDetail;
  modifiedAt?: string;
  [key: string]: unknown;
}

export interface ScheduledTransactionListResponse {
  metaData: MetaData;
  resources: ScheduledTransaction[];
}

/**
 * An account as this server hands it out. Same reasoning as
 * `CachedTransaction`: every money field becomes integer cents plus a formatted
 * string, so no caller receives a float it could sum.
 */
export type CachedAccount = Omit<
  Account,
  | "balanceAsOf"
  | "currentBalanceAsOf"
  | "onlineBalance"
  | "creditLimit"
  | "statementDueAmount"
  | "statementMinPayment"
  | "statementPastDueAmount"
  | "statementCloseBalance"
  | "statementLastPaymentAmount"
  | "normalizedBalance"
  | "goalBalance"
> & {
  id: string;
  type?: string;
  name?: string;
  balanceCents?: number;
  balanceFormatted?: string;
  currentBalanceCents?: number;
  onlineBalanceCents?: number;
  creditLimitCents?: number;
  statementDueAmountCents?: number;
  statementDueAmountFormatted?: string;
  statementMinPaymentCents?: number;
  statementPastDueAmountCents?: number;
  statementCloseBalanceCents?: number;
  statementLastPaymentAmountCents?: number;
  normalizedBalanceCents?: number;
  goalBalanceCents?: number;
};

export type CachedScheduledTransaction = Omit<ScheduledTransaction, "transaction"> & {
  id: string;
  transaction?: Omit<ScheduledTransactionDetail, "amount"> & {
    amountCents?: number;
    amountFormatted?: string;
  };
};

/**
 * A transaction as this server hands it out, rather than as Simplifi sent it.
 *
 * `amount` is deliberately absent. Upstream sends a decimal number, and any
 * consumer holding one will eventually add it to another one — which is the
 * drift `Cents` exists to prevent. Replacing it with an integer and a
 * pre-formatted string means the float is not merely discouraged downstream,
 * it is unavailable.
 */
export type CachedTransaction = Omit<Transaction, "amount"> & {
  // Re-declared, not redundant. `Transaction` carries an index signature, and
  // `Omit` over such a type collapses its named properties into that signature —
  // `id` becomes `unknown` and `coa` becomes `{}`. Restating the fields the code
  // actually reads restores them; the intersection wins over the index signature.
  id: string;
  coa?: CoaRef;
  transfer?: TransferRef;
  split?: TransactionSplit;
  /** CASH_FLOW or INVESTMENT. Read by the analysis layer; see src/analysis/classify.ts. */
  type?: string;
  state?: string;
  accountId?: string;
  payee?: string;
  renamedPayee?: string;
  mlInferredPayee?: string;

  /** Integer cents. The only value to do arithmetic with. */
  amountCents?: number;
  /** Decimal string for display. Never parse this back into a number. */
  amountFormatted?: string;
  /**
   * The date the transaction occurred, `YYYY-MM-DD`. What filters and ordering
   * use. It can differ from the `postedOn` settlement date.
   */
  transactionDate?: string;
  /**
   * Which field `transactionDate` came from. Reported rather than left to be
   * guessed: a total that silently mixes transaction dates with settlement
   * dates is the kind of number that looks right and is not.
   */
  transactionDateSource?: "cpData.txnOn" | "postedOn";
};

export interface TransactionPage {
  items: CachedTransaction[];
  total: number;
  nextCursor?: string;
}
