# make test                      run the tests, then print the price table (cluster of 15 items within 5%)
# make test UNITS=50 PCT=1.5     same, with your own cluster size (items) and percentage
# make test UNDERCUT=2 UNIT=%    undercut by 2% instead of $1
# make table UNITS=30 PCT=1      only the table
# make fetch KEY=yourPublicKey ITEMS="206 274"   save fresh market listings as fixtures

UNITS    ?= 15
PCT      ?= 5
UNDERCUT ?= 1
UNIT     ?= $$

.PHONY: test table fetch

test:
	@node --test --test-reporter=dot
	@$(MAKE) --no-print-directory table

table:
	@CLUSTER_UNITS='$(UNITS)' CLUSTER_PCT='$(PCT)' UNDERCUT='$(UNDERCUT)' UNDERCUT_UNIT='$(UNIT)' node tests/report.mjs

fetch:
	@test -n "$(KEY)" -a -n "$(ITEMS)" || { echo 'Usage: make fetch KEY=yourPublicKey ITEMS="206 274"'; exit 1; }
	@TORN_API_KEY='$(KEY)' node tests/fetch-market.mjs $(ITEMS)
