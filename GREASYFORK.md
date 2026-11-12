# Torn Bazaar Helper

One-click quantity and pricing for your [Torn](https://www.torn.com) bazaar. It adds a few buttons to the **Add Items** and **Manage Items** pages and fills in prices from the Item Market for you.

The script only fills in fields. It never saves, lists, or buys anything: you always confirm with Torn's own button.

## Features

- **Max** button: fills in the full quantity you own.
- **$** button on every price field: sets a price just below the market.
- **Update all prices** on Manage Items: reprices the items on the page in one go.
- **Two pricing modes:** undercut the lowest price, or undercut the lowest *cluster* (the first price with a meaningful number of items for sale), so a handful of cheap items doesn't drag your price down.
- **Colours** show what changed: green for a price that went up, orange for one that went down, red for a big drop.
- **Warnings** when a price is below what NPC shops pay, or far below your previous price.
- **Show above MV:** highlights in blue the prices that are above Torn's market value.
- **Light on the API:** remembers fetched prices, and you choose how many calls per minute it may use.

## Setup

1. Install the script and open your bazaar.
2. Click **⚙ Bazaar Helper** in the bottom-left corner.
3. Paste a Torn API key and save. A **Public** key is enough (Torn → Settings → API Keys). The key stays in your browser and is sent only to `api.torn.com`.

## Good to know

- Prices come from the **Item Market** through the official Torn API. Other players' bazaars are not included.
- Torn refreshes that market data only about once an hour, so prices can lag the live market. Each message shows how old the data is.
- **Update all prices** works on the rows currently loaded on the page. On a long list, scroll and run it again.

## Links

- Source code, full documentation and issues: [github.com/piotrowski/torn-bazaar-helper](https://github.com/piotrowski/torn-bazaar-helper)
- Author: [xDevil2 [4501067]](https://www.torn.com/profiles.php?XID=4501067)

Free to use. If it saves you time, donations in-game to [xDevil2 [4501067]](https://www.torn.com/profiles.php?XID=4501067) are welcome. Thank you!
