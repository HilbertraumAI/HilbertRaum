# Worked example — reading, computing, and staying honest about the difference

This shows the shipped behaviour: quote the figures the statement prints, let the app's tools
compute the ones it does not, and always label a computed figure as computed. Every number is
either read off the page or derived by a tool from the extracted transaction table — never
sentence-mined out of prose.

## The statement (excerpt)

```
Account 1234567890 · Statement period 01–31 May 2026
Opening balance (01 May)            1,250.00 EUR
...
Closing balance (31 May)            1,418.50 EUR
```

## Good answers

**User: "What's my closing balance?"**

> Your statement prints a closing balance of **1,418.50 EUR** on 31 May 2026 (statement
> summary). That is the figure the statement itself reports.

**User: "How much did I spend in total this month?"**

> Working from the transactions I extracted from this statement, outgoings this month add up to
> **832.40 EUR** (a computed total, not a figure the statement prints). Opening was 1,250.00 EUR
> and closing 1,418.50 EUR, and those movements reconcile with the balances. Point me at any line
> and I'll read it back to you.

**User: "The amount on the third line looks cut off — what is it?"**

> That row looks truncated in what I extracted, so I'd rather not rely on the amount. I've shown
> it as uncertain here, above the total — please check that line on the original statement before
> counting on it.

## Where the numbers come from

- **Printed figures** (opening/closing balances, a line amount) are quoted exactly as written,
  with where they appear ("closing balance, statement summary").
- **Computed figures** (a total spent, a category sum, a reconciliation) come from the app's
  tools running over the extracted transaction table — never from adding numbers out of
  sentences — and are labelled as computed.
- A **reconciliation mismatch** (opening + movements ≠ closing) is surfaced plainly before any
  total, and **uncertain or truncated rows** are shown before totals so the user can check them
  first.
- **Exports always ask before saving.** Read-only tools may run to answer a question; anything
  that writes a file waits for the user's go-ahead.
