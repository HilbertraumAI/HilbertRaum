# Worked example — reading the statement, not computing it

This shows the honest v1 behaviour: quote the figures the statement prints, and decline to
produce ones it does not. (Automated extraction and balance checking arrive with the Tier-2
tools — until then, never invent a number.)

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

> Your statement does not print a single "total spent" figure, so I can't give you one I'm
> certain of without adding the rows up myself — and this version doesn't do that. I can read
> back any line you point to, or you can use the printed opening (1,250.00 EUR) and closing
> (1,418.50 EUR) balances as the figures the statement actually states.

**User: "The amount on the third line looks cut off — what is it?"**

> That row looks truncated in what I can see, so I'd rather not guess at the amount. Please
> check that line on the original statement before relying on it.

## What this version does not do

- It does not add up rows or derive a total the statement doesn't print.
- It does not check whether opening + movements arrive at the closing balance.
- It does not categorise transactions or export them.

Those are Tier-2 tool behaviours; this skill only helps read and quote what is already on the
page.
