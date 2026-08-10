/**
 * 演示数据：在还没拿到 API Key 之前，先看看界面长什么样。
 *
 *   node scripts/demo-seed.js          填充演示数据
 *   node scripts/demo-seed.js --clear  清掉，恢复干净状态
 *
 * 注意：这里的价格是编的，别拿去下单。
 */
import { store } from '../src/store.js';
import { extractSpecs } from '../src/specs.js';

const RAW = [
  ['6618924', 'HP', 'HP - Victus 15 15.6" Full HD 144Hz Gaming Laptop - Intel Core i5 13420H - 8GB DDR4 Memory - NVIDIA GeForce RTX 3050 - 512GB SSD', 'i5 13420H', 468.99, 457.99, 5.06],
  ['6578512', 'Lenovo', 'Lenovo - LOQ 15.6" Gaming Laptop - AMD Ryzen 5 7235HS - NVIDIA GeForce RTX 3050 - 12GB DDR5 Memory - 512GB SSD', 'r5 7235HS', 466.99, 465.99, 5.29],
  ['6572582', 'ASUS', 'ASUS - ROG Zephyrus G16 16" Gaming Laptop - Intel Core i7 13620H - NVIDIA GeForce RTX 4070 - 16GB DDR4 Memory - 512GB SSD', 'i7 13620H', 904.99, 902.99, 4.41],
  ['6571484', 'Alienware', 'Alienware - m16 R2 16" Gaming Laptop - Intel Core Ultra 7 155H - NVIDIA GeForce RTX 4070 - 16GB DDR5 Memory - 1TB SSD', 'u7 155H', 937.99, 936.99, 5.73],
  ['6575389', 'Lenovo', 'Lenovo - Legion Pro 5i 16" Gaming Laptop - Intel Core i9 14900HX - NVIDIA GeForce RTX 4060 - 16GB DDR5 Memory - 1TB SSD', 'i9 14900HX', 1037.99, 1036.99, 5.51],
  ['6628459', 'HP', 'HP - OmniBook X 14" Laptop - Intel Core Ultra 7 255H - 32GB LPDDR5X Memory - 1TB SSD', 'u7 255H', 1129.99, 1091.99, 4.63],
  ['6572179', 'Samsung', 'Samsung - Galaxy Book4 Ultra 16" Laptop - Intel Core Ultra 7 155H - 16GB LPDDR5X Memory - NVIDIA GeForce RTX 4050 - 1TB SSD', 'u7 155H', 1419.99, 1119.99, 4.19],
  ['6572156', 'ASUS', 'ASUS - ROG Strix G16 16" Gaming Laptop - Intel Core i9 14900HX - NVIDIA GeForce RTX 4070 - 32GB DDR5 Memory - 1TB SSD', 'i9 14900HX', 1439.96, 1169.96, 5.51],
  ['6618925', 'HP', 'HP - Victus 15 15.6" Gaming Laptop - Intel Core i7 13620H - NVIDIA GeForce RTX 5060 - 16GB DDR5 Memory - 1TB SSD', 'i7 13620H', 1327.99, 1177.99, 5.06],
  ['6576921', 'Alienware', 'Alienware - X16 R2 16" Gaming Laptop - Intel Core Ultra 9 185H - NVIDIA GeForce RTX 4070 - 32GB LPDDR5X Memory - 1TB SSD', 'u9 185H', 1286.99, 1194.99, 5.95],
  ['6584438', 'ASUS', 'ASUS - ProArt P16 16" Laptop - AMD Ryzen AI 9 HX 370 - NVIDIA GeForce RTX 4060 - 32GB LPDDR5X Memory - 1TB SSD', 'rAI9 HX 370', 1466.99, 1239.99, 4.19],
  ['6575390', 'Lenovo', 'Lenovo - Legion Pro 5i 16" Gaming Laptop - Intel Core i9 14900HX - NVIDIA GeForce RTX 4070 - 32GB DDR5 Memory - 2TB SSD', 'i9 14900HX', 1540.99, 1418.99, 5.51],
  ['6618921', 'HP', 'HP - OMEN Transcend 14 14" Gaming Laptop - Intel Core Ultra 9 285H - NVIDIA GeForce RTX 5070 - 32GB LPDDR5X Memory - 1TB SSD', 'u9 285H', 1638.99, 1527.99, 3.53],
  ['6572635', 'Alienware', 'Alienware - m18 R2 18" Gaming Laptop - Intel Core i9 14900HX - NVIDIA GeForce RTX 4080 - 32GB DDR5 Memory - 1TB SSD', 'i9 14900HX', 1589.99, 1588.99, 8.82],
  ['6613954', 'ASUS', 'ASUS - ROG Zephyrus G14 14" OLED 120Hz Gaming Laptop - AMD Ryzen AI 9 HX 370 - NVIDIA GeForce RTX 5070 Ti - 32GB LPDDR5X Memory - 1TB SSD', 'rAI9 HX 370', 2247.99, 1990.99, 3.53],
  ['6617485', 'ASUS', 'ASUS - ROG Zephyrus G16 16" OLED 240Hz Gaming Laptop - Intel Core Ultra 9 285H - NVIDIA GeForce RTX 5070 Ti - 16GB LPDDR5X Memory - 1TB SSD', 'u9 285H', 2373.99, 2206.99, 4.41],
  ['6617091', 'Lenovo', 'Lenovo - Legion Pro 5i 16" Gaming Laptop - Intel Core Ultra 9 275HX - NVIDIA GeForce RTX 5070 Ti - 32GB DDR5 Memory - 2TB SSD', 'u9 275HX', 2344.99, 2213.99, 5.29],
  ['6546179', 'Razer', 'Razer - Blade 14 14" Gaming Laptop - AMD Ryzen 9 7940HS - NVIDIA GeForce RTX 4070 - 16GB DDR5 Memory - 1TB SSD', 'r9 7940HS', 2457.99, 2375.99, 3.97],
  ['6612225', 'HP', 'HP - OMEN Max 16 16" Gaming Laptop - Intel Core Ultra 9 275HX - NVIDIA GeForce RTX 5080 - 32GB DDR5 Memory - 1TB SSD', 'u9 275HX', 2706.99, 2413.99, 5.95],
  ['6635274', 'ASUS', 'ASUS - ROG Strix SCAR 18 18" Gaming Laptop - Intel Core Ultra 9 275HX - NVIDIA GeForce RTX 5070 Ti - 32GB DDR5 Memory - 1TB SSD', 'u9 275HX', 2537.99, 2483.99, 7.72],
  ['6632697', 'Alienware', 'Alienware - Area 51 16" Gaming Laptop - Intel Core Ultra 9 275HX - NVIDIA GeForce RTX 5070 - 32GB DDR5 Memory - 2TB SSD', 'u9 275HX', 3003.99, 2987.99, 6.83],
  ['6613957', 'ASUS', 'ASUS - ROG Strix SCAR 18 18" Gaming Laptop - Intel Core Ultra 9 275HX - NVIDIA GeForce RTX 5090 - 32GB DDR5 Memory - 2TB SSD', 'u9 275HX', 4359.99, 4016.99, 7.72],
  ['6588754', 'HP', 'HP - OMEN 45L Gaming Desktop - Intel Core i9 14900K - NVIDIA GeForce RTX 4080 SUPER - 32GB DDR5 Memory - 2TB SSD', 'i9 14900K', 2799.99, 2299.99, null],
  ['6571022', 'Lenovo', 'Lenovo - Legion Tower 7i Gaming Desktop - Intel Core i9 14900KF - NVIDIA GeForce RTX 4090 - 32GB DDR5 Memory - 1TB SSD', 'i9 14900KF', 3499.99, 3149.99, null],
  ['6534678', 'Dell', 'Dell - Refurbished XPS 15 15.6" Laptop - Intel Core i7 13700H - NVIDIA GeForce RTX 4050 - 16GB DDR5 Memory - 512GB SSD', 'i7 13700H', 1699.99, 949.99, 4.21, 'Refurbished'],
  ['6549812', 'Apple', 'Apple - MacBook Pro 14" Laptop - M4 Pro chip - 24GB Memory - 512GB SSD', 'M4 Pro', 1999.99, 1749.99, 3.4, 'Open-Box (Excellent)'],
];

function mkDetails(row) {
  const [, , , cpuShort, , , lbs, condition] = row;
  const name = row[2];
  const d = [];
  const ramM = name.match(/(\d+)GB\s+(LPDDR5X|DDR5|DDR4)/i);
  const diskM = name.match(/(\d+)(GB|TB)\s+SSD/i);
  const screenM = name.match(/(\d{2}(?:\.\d)?)"/);
  if (ramM) {
    d.push({ name: 'System Memory (RAM)', value: `${ramM[1]} gigabytes` });
    d.push({ name: 'Type of Memory (RAM)', value: ramM[2].toUpperCase() });
    if (/DDR5$/i.test(ramM[2])) d.push({ name: 'Memory Speed', value: '5600 megahertz' });
  }
  if (diskM) d.push({ name: 'Total Storage Capacity', value: `${diskM[1]} ${/tb/i.test(diskM[2]) ? 'terabytes' : 'gigabytes'}` });
  if (lbs) d.push({ name: 'Product Weight', value: `${lbs} pounds` });
  if (screenM) d.push({ name: 'Screen Size', value: `${screenM[1]} inches` });
  if (/desktop/i.test(name)) d.push({ name: 'Product Type', value: 'Desktop' });
  void cpuShort; void condition;
  return d;
}

function build(row) {
  const [sku, brand, name, , regular, sale, , condition] = row;
  const p = {
    sku, name, manufacturer: brand,
    condition: condition || 'New',
    url: `https://www.bestbuy.com/site/-/${sku}.p?skuId=${sku}`,
    image: null,
    price: sale,
    regularPrice: regular,
    percentOff: Math.round(((regular - sale) / regular) * 1000) / 10,
    inStock: true,
    category: /desktop/i.test(name) ? 'Computers › Desktops' : 'Computers › Laptops',
    source: 'api',
    details: mkDetails(row),
  };
  p.specs = extractSpecs(p);
  delete p.details;
  return p;
}

if (process.argv.includes('--clear')) {
  store.clearBoard();
  store.clearEvents();
  store.flushAll();
  console.log('演示数据已清空。');
  process.exit(0);
}

const now = Date.now();
let drops = 0;

// 每台机器模拟一小段价格轨迹，让"新低""降价"这些标记有真实语义
const TRACKS = [
  [1.12, 1.06, 1.06, 1.0],   // 一路降到新低
  [1.04, 1.09, 1.02, 1.0],   // 波动后创新低
  [1.0, 1.0, 1.0, 1.0],      // 一直没动
  [1.0, 1.03, 1.05, 1.02],   // 涨回去了
  [1.15, 1.15, 1.01, 1.0],   // 一次大跳水
];

RAW.forEach((row, i) => {
  const p = build(row);
  const track = TRACKS[i % TRACKS.length];
  let prev = null;
  let key = null;

  track.forEach((mult, step) => {
    const price = Math.round(p.price * mult * 100) / 100;
    const r = store.upsertBoard({ ...p, price }, 'seed-demo');
    key = r.row.key;
    const ts = now - (track.length - step) * 3600000 - i * 60000;

    if (r.isNew) {
      store.addEvent({
        ts, type: 'found', searchId: 'seed-demo', searchName: '演示数据',
        boardKey: key, sku: p.sku, name: p.name, url: p.url,
        condition: p.condition, specs: p.specs, price,
        regularPrice: p.regularPrice, pct: p.percentOff, note: '新发现',
      });
    } else if (r.dropped) {
      drops++;
      const delta = Math.round((prev - price) * 100) / 100;
      store.addEvent({
        ts, type: i % 11 === 0 && step === track.length - 1 ? 'target' : 'drop',
        searchId: 'seed-demo', searchName: '演示数据',
        boardKey: key, sku: p.sku, name: p.name, url: p.url,
        condition: p.condition, specs: p.specs,
        price, prevPrice: prev, delta,
        pct: Math.round((delta / prev) * 1000) / 10,
        regularPrice: p.regularPrice,
        isAllTimeLow: r.row.prevMinPrice != null && price < r.row.prevMinPrice && r.row.seenCount >= 3,
        note: '演示数据',
      });
    } else if (prev != null && price > prev) {
      store.addEvent({
        ts, type: 'rise', searchId: 'seed-demo', searchName: '演示数据',
        boardKey: key, sku: p.sku, name: p.name, url: p.url,
        condition: p.condition, specs: p.specs,
        price, prevPrice: prev,
        delta: Math.round((price - prev) * 100) / 100,
        pct: Math.round(((price - prev) / prev) * 1000) / 10,
        regularPrice: p.regularPrice, note: '涨价',
      });
    }
    prev = price;
  });
});

store.flushAll();
console.log(`已写入 ${RAW.length} 台演示机器、${drops} 条降价记录。`);
console.log('看完记得清掉：node scripts/demo-seed.js --clear');
