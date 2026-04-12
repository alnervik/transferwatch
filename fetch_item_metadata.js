// Kör med: node fetch_item_metadata.js
// Sparar item metadata till item_metadata.json

const fs = require("fs");

async function fetchItemMetadata() {
  console.log("Hämtar item metadata från API...");

  const response = await fetch(
    "https://api.tibiamarket.top:8001/item_metadata"
  );

  if (!response.ok) {
    throw new Error(`API svarade med status ${response.status}`);
  }

  const data = await response.json();

  fs.writeFileSync("item_metadata.json", JSON.stringify(data, null, 2));

  console.log(`Klart! ${data.length} items sparade till item_metadata.json`);

  // Hitta Tibia Coin specifikt och logga dess ID
  const tibiaCoin = data.find((item) =>
    item.name.toLowerCase().includes("tibia coin")
  );
  if (tibiaCoin) {
    console.log(`Tibia Coin hittad! ID: ${tibiaCoin.id}`);
  } else {
    console.log("OBS: Kunde inte hitta Tibia Coin i item-listan.");
  }
}

fetchItemMetadata().catch(console.error);
