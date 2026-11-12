# make test                      run the tests, then print the price table (3 listings or 15 items within 5%)
# make test SIZE=4 PCT=1.5       same, with your own cluster settings
# make test UNITS=50             a cluster can also be 50 items in total (UNITS=0 counts listings only)
# make test UNDERCUT=2 UNIT=%    undercut by 2% instead of $1
# make table SIZE=5 PCT=1        only the table
# make fetch KEY=yourPublicKey ITEMS="206 274"   save fresh market listings as fixtures

SIZE     ?= 3
PCT      ?= 5
UNITS    ?= 15
UNDERCUT ?= 1
UNIT     ?= $$

.PHONY: test table fetch

test:
	@node --test --test-reporter=dot
	@$(MAKE) --no-print-directory table

table:
	@CLUSTER_SIZE='$(SIZE)' CLUSTER_PCT='$(PCT)' CLUSTER_UNITS='$(UNITS)' UNDERCUT='$(UNDERCUT)' UNDERCUT_UNIT='$(UNIT)' node tests/report.mjs

fetch:
	@test -n "$(KEY)" -a -n "$(ITEMS)" || { echo 'Usage: make fetch KEY=yourPublicKey ITEMS="206 274"'; exit 1; }
	@TORN_API_KEY='$(KEY)' node tests/fetch-market.mjs $(ITEMS)
