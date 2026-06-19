
var STORAGE_KEY_MATERIALS = 'dental_materials_v2';
var STORAGE_KEY_USAGES = 'dental_usages_v2';
var STORAGE_KEY_PLANS = 'dental_purchase_plans_v2';
var editingMaterialId = null;
var chartInstances = {};
var csvImportType = 'material';
var dashboardView = 'risk';
var weeklySortBy = 'stockout';
var lastSimulationSnapshot = null;

function loadData(key) {
  try { return JSON.parse(localStorage.getItem(key)) || []; }
  catch(e) { return []; }
}
function saveData(key, data) { localStorage.setItem(key, JSON.stringify(data)); }

function genId() { return Date.now().toString(36) + Math.random().toString(36).substr(2, 5); }

function daysBetween(d1, d2) {
  return Math.ceil((new Date(d2) - new Date(d1)) / 86400000);
}

function addDays(dateStr, days) {
  var d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return formatDate(d);
}

function formatDate(d) {
  if (!d) return '-';
  var dt = new Date(d);
  return dt.getFullYear() + '-' + String(dt.getMonth()+1).padStart(2,'0') + '-' + String(dt.getDate()).padStart(2,'0');
}

function today() { return formatDate(new Date()); }

function getWeeklyAvg(materialName) {
  var usages = loadData(STORAGE_KEY_USAGES).filter(function(u) { return u.materialName === materialName; });
  if (usages.length === 0) return 0;
  var now = new Date();
  var cutoff = new Date(now); cutoff.setDate(cutoff.getDate() - 56);
  var recent = usages.filter(function(u) { return new Date(u.date) >= cutoff; });
  if (recent.length === 0) return 0;
  var total = recent.reduce(function(s, u) { return s + (parseFloat(u.quantity) || 0); }, 0);
  var days = Math.max(1, (now - cutoff) / 86400000);
  return total / (days / 7);
}

function getWeeklyAvgByDoctor(materialName) {
  var usages = loadData(STORAGE_KEY_USAGES).filter(function(u) { return u.materialName === materialName; });
  var now = new Date();
  var cutoff = new Date(now); cutoff.setDate(cutoff.getDate() - 56);
  var recent = usages.filter(function(u) { return new Date(u.date) >= cutoff; });
  var byDoctor = {};
  recent.forEach(function(u) {
    if (!byDoctor[u.doctor]) byDoctor[u.doctor] = 0;
    byDoctor[u.doctor] += (parseFloat(u.quantity) || 0);
  });
  var weeks = 8;
  Object.keys(byDoctor).forEach(function(d) { byDoctor[d] = byDoctor[d] / weeks; });
  return byDoctor;
}

function getWeeklyAvgByDept(materialName) {
  var usages = loadData(STORAGE_KEY_USAGES).filter(function(u) { return u.materialName === materialName; });
  var now = new Date();
  var cutoff = new Date(now); cutoff.setDate(cutoff.getDate() - 56);
  var recent = usages.filter(function(u) { return new Date(u.date) >= cutoff; });
  var byDept = {};
  recent.forEach(function(u) {
    if (!byDept[u.department]) byDept[u.department] = 0;
    byDept[u.department] += (parseFloat(u.quantity) || 0);
  });
  var weeks = 8;
  Object.keys(byDept).forEach(function(d) { byDept[d] = byDept[d] / weeks; });
  return byDept;
}

function getWeeklyTrendByDoctor(materialName) {
  var usages = loadData(STORAGE_KEY_USAGES).filter(function(u) { return u.materialName === materialName; });
  var now = new Date();
  var doctors = [];
  var doctorSet = {};
  usages.forEach(function(u) { if (!doctorSet[u.doctor]) { doctorSet[u.doctor] = true; doctors.push(u.doctor); } });
  var weeks = [];
  for (var i = 7; i >= 0; i--) {
    var weekEnd = new Date(now); weekEnd.setDate(weekEnd.getDate() - i * 7);
    var weekStart = new Date(weekEnd); weekStart.setDate(weekStart.getDate() - 7);
    var label = 'Week ' + (8-i);
    var byDoctor = {};
    doctors.forEach(function(doc) {
      var weekUsages = usages.filter(function(u) { return u.doctor === doc && new Date(u.date) >= weekStart && new Date(u.date) < weekEnd; });
      byDoctor[doc] = weekUsages.reduce(function(s, u) { return s + (parseFloat(u.quantity) || 0); }, 0);
    });
    weeks.push(Object.assign({ label: label }, byDoctor));
  }
  return { weeks: weeks, doctors: doctors };
}

function getFIFOBatches(materialName) {
  var materials = loadData(STORAGE_KEY_MATERIALS);
  return materials
    .filter(function(m) { return m.name === materialName && m.currentStock > 0; })
    .sort(function(a, b) { return new Date(a.expiryDate) - new Date(b.expiryDate); });
}

function calcFIFODepletion(materialName) {
  var fifo = getFIFOBatches(materialName);
  var weeklyAvg = getWeeklyAvg(materialName);
  var cumStock = 0;
  var result = [];

  fifo.forEach(function(batch, idx) {
    var startWeek = weeklyAvg > 0 ? cumStock / weeklyAvg : Infinity;
    cumStock += batch.currentStock;
    var depleteWeek = weeklyAvg > 0 ? cumStock / weeklyAvg : Infinity;
    var weeksToExpiry = daysBetween(today(), batch.expiryDate) / 7;

    var status, willScrapQty = 0, willScrapValue = 0, consumableQty = batch.currentStock;

    if (weeklyAvg <= 0) {
      status = weeksToExpiry <= 0 ? 'expired' : 'no_usage_data';
      if (weeksToExpiry > 0 && weeksToExpiry < 104) willScrapQty = batch.currentStock;
    } else if (weeksToExpiry <= startWeek) {
      status = 'scrap_before_use';
      willScrapQty = batch.currentStock;
    } else if (weeksToExpiry < depleteWeek) {
      status = 'partial_scrap';
      var usedWeeks = weeksToExpiry - startWeek;
      consumableQty = usedWeeks * weeklyAvg;
      willScrapQty = batch.currentStock - consumableQty;
    } else {
      status = 'normal';
    }

    willScrapValue = willScrapQty * (batch.price || 0);
    var finishDate = weeklyAvg > 0 ? addDays(today(), Math.ceil(depleteWeek * 7)) : null;

    result.push({
      batch: batch,
      idx: idx,
      fifoRank: idx + 1,
      weeklyAvg: weeklyAvg,
      startWeek: startWeek,
      depleteWeek: depleteWeek,
      weeksToExpiry: weeksToExpiry,
      status: status,
      consumableQty: Math.round(consumableQty * 100) / 100,
      willScrapQty: Math.round(willScrapQty * 100) / 100,
      willScrapValue: willScrapValue,
      finishDate: finishDate
    });
  });

  var totalDepleteWeek = weeklyAvg > 0 ? cumStock / weeklyAvg : null;
  var totalScrapValue = result.reduce(function(s, r) { return s + r.willScrapValue; }, 0);
  var totalScrapQty = result.reduce(function(s, r) { return s + r.willScrapQty; }, 0);

  return {
    batches: result,
    rawFIFO: fifo,
    weeklyAvg: weeklyAvg,
    totalStock: cumStock,
    totalDepleteWeek: totalDepleteWeek,
    totalScrapQty: totalScrapQty,
    totalScrapValue: totalScrapValue,
    stockoutDate: totalDepleteWeek !== null ? addDays(today(), Math.ceil(totalDepleteWeek * 7)) : null
  };
}

function assessBatchRisk(material) {
  var remaining = daysBetween(today(), material.expiryDate);
  var weeklyAvg = getWeeklyAvg(material.name);
  var fifoInfo = calcFIFODepletion(material.name);
  var batchInfo = fifoInfo.batches.find(function(b) { return b.batch.id === material.id; });

  var weeksToDeplete, canFinish;
  if (batchInfo) {
    weeksToDeplete = batchInfo.depleteWeek;
    canFinish = batchInfo.status === 'normal';
  } else {
    weeksToDeplete = weeklyAvg > 0 ? material.currentStock / weeklyAvg : Infinity;
    var weeksToExpiry = remaining / 7;
    canFinish = weeksToDeplete <= weeksToExpiry;
  }

  var level, label, suggestion;
  var scrapValue = batchInfo ? batchInfo.willScrapValue : (canFinish ? 0 : material.currentStock * (material.price || 0));

  if (remaining <= 0) {
    level = 'high'; label = 'Expired'; suggestion = 'Remove from stock immediately';
  } else if (remaining <= 30) {
    level = 'high'; label = 'Expiring soon';
    suggestion = weeklyAvg === 0 ? 'Contact supplier for exchange' : 'Prioritize usage';
  } else if (remaining <= 90) {
    level = canFinish ? 'low' : 'medium';
    label = canFinish ? 'Controlled' : 'Overstock risk';
    suggestion = canFinish ? 'Normal usage' : 'Suspend purchase / Transfer';
  } else {
    level = 'low'; label = 'Safe'; suggestion = 'Normal management';
  }
  return {
    remaining: remaining,
    weeklyAvg: weeklyAvg,
    weeksToDeplete: weeksToDeplete,
    canFinish: canFinish,
    level: level,
    label: label,
    suggestion: suggestion,
    scrapValue: scrapValue,
    fifoStatus: batchInfo ? batchInfo.status : null,
    fifoStartWeek: batchInfo ? batchInfo.startWeek : null
  };
}

function simulateConsumption(materialName, weeklyUsage, newBatchQty, newBatchExpiry, newBatchPrice) {
  var batches = getFIFOBatches(materialName);
  var unit = batches.length > 0 ? batches[0].unit : 'pcs';
  var avgPrice = 0;
  if (batches.length > 0) {
    var totalPrice = batches.reduce(function(s, b) { return s + (b.price || 0); }, 0);
    avgPrice = totalPrice / batches.length;
  }

  if (newBatchQty > 0 && newBatchExpiry) {
    var usePrice = (typeof newBatchPrice === 'number' && !isNaN(newBatchPrice) && newBatchPrice > 0)
      ? newBatchPrice : avgPrice;
    batches.push({
      id: 'new',
      name: materialName,
      batchNo: 'New Batch',
      currentStock: newBatchQty,
      unit: unit,
      expiryDate: newBatchExpiry,
      price: usePrice,
      isNew: true
    });
    batches.sort(function(a, b) { return new Date(a.expiryDate) - new Date(b.expiryDate); });
  }

  var events = [];
  var totalScrappedQty = 0;
  var totalScrappedValue = 0;
  var stockoutWeek = null;
  var currentWeek = 0;
  var maxWeeks = 104;

  var batchesState = batches.map(function(b) {
    return Object.assign({}, b, { remainingStock: b.currentStock });
  });

  var totalStock = batchesState.reduce(function(s, b) { return s + b.remainingStock; }, 0);
  if (totalStock <= 0) {
    return {
      events: [{ type: 'stockout', date: today(), desc: '当前无库存，立即断货' }],
      totalScrappedQty: 0,
      totalScrappedValue: 0,
      stockoutWeek: 0,
      totalStock: 0,
      allBatches: batches
    };
  }

  while (currentWeek < maxWeeks && totalStock > 0) {
    var weekStartDate = addDays(today(), currentWeek * 7);
    var weekUsage = weeklyUsage;

    for (var i = 0; i < batchesState.length; i++) {
      var batch = batchesState[i];
      if (batch.remainingStock <= 0) continue;

      var daysToExpiry = daysBetween(weekStartDate, batch.expiryDate);
      if (daysToExpiry <= 0) {
        if (batch.remainingStock > 0) {
          events.push({
            type: 'scrap',
            date: batch.expiryDate,
            batchNo: batch.batchNo,
            qty: batch.remainingStock,
            value: batch.remainingStock * (batch.price || 0),
            desc: 'Batch ' + batch.batchNo + ' expired, scrap ' + batch.remainingStock + ' ' + unit + ' (value ¥' + (batch.remainingStock * (batch.price || 0)).toFixed(2) + ')'
          });
          totalScrappedQty += batch.remainingStock;
          totalScrappedValue += batch.remainingStock * (batch.price || 0);
          batch.remainingStock = 0;
        }
        continue;
      }

      if (weekUsage > 0 && batch.remainingStock > 0) {
        var consumeQty = Math.min(weekUsage, batch.remainingStock);
        batch.remainingStock -= consumeQty;
        weekUsage -= consumeQty;

        if (batch.remainingStock === 0) {
          events.push({
            type: 'deplete',
            date: addDays(today(), currentWeek * 7),
            batchNo: batch.batchNo,
            desc: 'Batch ' + batch.batchNo + ' depleted, fully consumed'
          });
        }
      }

      if (weekUsage <= 0) break;
    }

    totalStock = batchesState.reduce(function(s, b) { return s + b.remainingStock; }, 0);
    if (totalStock <= 0 && stockoutWeek === null) {
      stockoutWeek = currentWeek;
      events.push({
        type: 'stockout',
        date: addDays(today(), currentWeek * 7),
        desc: 'All batches exhausted, stockout expected'
      });
      break;
    }

    currentWeek++;
  }

  events.sort(function(a, b) { return new Date(a.date) - new Date(b.date); });

  return {
    events: events,
    totalScrappedQty: totalScrappedQty,
    totalScrappedValue: totalScrappedValue,
    stockoutWeek: stockoutWeek,
    stockoutDate: stockoutWeek !== null ? addDays(today(), stockoutWeek * 7) : null,
    totalStock: totalStock,
    allBatches: batches,
    unit: unit
  };
}

function predict12Weeks(materialName) {
  var batches = getFIFOBatches(materialName);
  if (batches.length === 0) return null;

  var weeklyUsage = getWeeklyAvg(materialName);
  var unit = batches[0].unit;

  var batchesState = batches.map(function(b) {
    return Object.assign({}, b, { remainingStock: b.currentStock });
  });

  var weekLabels = [];
  var stockLevels = [];
  var events = [];
  var scrapInfo = { totalQty: 0, totalValue: 0, week: null };
  var stockoutInfo = { week: null, date: null };

  for (var w = 0; w <= 12; w++) {
    weekLabels.push('W' + w);
    var weekDate = addDays(today(), w * 7);

    var totalStock = batchesState.reduce(function(s, b) { return s + b.remainingStock; }, 0);
    stockLevels.push(totalStock);

    for (var i = 0; i < batchesState.length; i++) {
      var batch = batchesState[i];
      if (batch.remainingStock <= 0) continue;

      var daysToExpiry = daysBetween(weekDate, batch.expiryDate);
      if (daysToExpiry <= 0 && w > 0) {
        if (batch.remainingStock > 0) {
          var batchPrice = batch.price || 0;
          events.push({
            week: w,
            type: 'scrap',
            batchNo: batch.batchNo,
            qty: batch.remainingStock,
            value: batch.remainingStock * batchPrice,
            date: batch.expiryDate
          });
          scrapInfo.totalQty += batch.remainingStock;
          scrapInfo.totalValue += batch.remainingStock * batchPrice;
          if (scrapInfo.week === null) scrapInfo.week = w;
          batch.remainingStock = 0;
        }
      }
    }

    totalStock = batchesState.reduce(function(s, b) { return s + b.remainingStock; }, 0);
    if (totalStock <= 0 && stockoutInfo.week === null) {
      stockoutInfo.week = w;
      stockoutInfo.date = weekDate;
    }

    if (w < 12 && weeklyUsage > 0) {
      var usageLeft = weeklyUsage;
      for (var j = 0; j < batchesState.length; j++) {
        if (batchesState[j].remainingStock > 0) {
          var consume = Math.min(usageLeft, batchesState[j].remainingStock);
          batchesState[j].remainingStock -= consume;
          usageLeft -= consume;
          if (usageLeft <= 0) break;
        }
      }
    }
  }

  var hasRisk = scrapInfo.totalQty > 0 || stockoutInfo.week !== null;

  return {
    materialName: materialName,
    unit: unit,
    weekLabels: weekLabels,
    stockLevels: stockLevels,
    weeklyUsage: weeklyUsage,
    events: events,
    scrapInfo: scrapInfo,
    stockoutInfo: stockoutInfo,
    hasRisk: hasRisk,
    batches: batches
  };
}

function switchPage(page) {
  document.querySelectorAll('.page').forEach(function(p) { p.classList.remove('active'); });
  document.querySelectorAll('.nav-item').forEach(function(n) { n.classList.remove('active'); });
  document.getElementById('page-' + page).classList.add('active');
  var navItem = document.querySelector('.nav-item[data-page="' + page + '"]');
  if (navItem) navItem.classList.add('active');
  var titles = { dashboard: 'Risk Dashboard', verify: 'Purchase Verification', data: 'Data Management' };
  document.getElementById('pageTitle').textContent = titles[page] || '';
  if (page === 'dashboard') renderDashboard();
  if (page === 'verify') renderVerify();
  if (page === 'data') renderDataPage();
}

function switchDashboardView(view) {
  dashboardView = view;
  document.querySelectorAll('.tab-item').forEach(function(t) { t.classList.remove('active'); });
  document.querySelector('.tab-item[data-view="' + view + '"]').classList.add('active');
  document.getElementById('view-risk').style.display = view === 'risk' ? 'block' : 'none';
  document.getElementById('view-prediction').style.display = view === 'prediction' ? 'block' : 'none';
  document.getElementById('view-weekly').style.display = view === 'weekly' ? 'block' : 'none';
  document.getElementById('riskFilters').style.display = view === 'risk' ? 'flex' : 'none';
  if (view === 'prediction') renderPredictions();
  if (view === 'weekly') renderWeeklyMeeting();
}

function renderDashboard() {
  renderStats();
  renderCategoryFilter();
  renderRiskList();
  if (dashboardView === 'prediction') renderPredictions();
  if (dashboardView === 'weekly') renderWeeklyMeeting();
}

function renderStats() {
  var materials = loadData(STORAGE_KEY_MATERIALS);
  var riskItems = materials.map(function(m) {
    return Object.assign({}, m, { risk: assessBatchRisk(m) });
  });
  var high = riskItems.filter(function(m) { return m.risk.level === 'high'; }).length;
  var medium = riskItems.filter(function(m) { return m.risk.level === 'medium'; }).length;
  var low = riskItems.filter(function(m) { return m.risk.level === 'low'; }).length;
  var totalValue = riskItems.reduce(function(s, m) { return s + (m.currentStock * (m.price || 0)); }, 0);

  var atRiskValue = 0;
  materials.forEach(function(m) {
    var sim = simulateConsumption(m.name, getWeeklyAvg(m.name), 0, null);
    atRiskValue += sim.totalScrappedValue;
  });

  document.getElementById('statsRow').innerHTML =
    '<div class="stat-card danger"><div class="label">High Risk</div><div class="value">' + high + '</div><div class="sub">Expiring in 30d or expired</div></div>' +
    '<div class="stat-card warning"><div class="label">Medium Risk</div><div class="value">' + medium + '</div><div class="sub">Overstock, may expire</div></div>' +
    '<div class="stat-card success"><div class="label">Low Risk</div><div class="value">' + low + '</div><div class="sub">Can finish before expiry</div></div>' +
    '<div class="stat-card"><div class="label">Projected Scrap</div><div class="value">&yen;' + atRiskValue.toFixed(0) + '</div><div class="sub">Based on current usage</div></div>';
}

function renderCategoryFilter() {
  var materials = loadData(STORAGE_KEY_MATERIALS);
  var categorySet = {};
  var categories = [];
  materials.forEach(function(m) { if (!categorySet[m.category]) { categorySet[m.category] = true; categories.push(m.category); } });
  var sel = document.getElementById('filterCategory');
  sel.innerHTML = '<option value="all">All Categories</option>' + categories.map(function(c) { return '<option value="' + c + '">' + c + '</option>'; }).join('');
}

function renderRiskList() {
  var materials = loadData(STORAGE_KEY_MATERIALS);
  var riskFilter = document.getElementById('filterRisk').value;
  var categoryFilter = document.getElementById('filterCategory').value;
  var searchText = document.getElementById('filterSearch').value.toLowerCase();

  var riskItems = materials.map(function(m) {
    return Object.assign({}, m, { risk: assessBatchRisk(m) });
  });

  var threeMonthsLater = new Date(); threeMonthsLater.setMonth(threeMonthsLater.getMonth() + 3);
  riskItems = riskItems.filter(function(m) {
    return new Date(m.expiryDate) <= threeMonthsLater || m.risk.level === 'high';
  });

  if (riskFilter !== 'all') riskItems = riskItems.filter(function(m) { return m.risk.level === riskFilter; });
  if (categoryFilter !== 'all') riskItems = riskItems.filter(function(m) { return m.category === categoryFilter; });
  if (searchText) riskItems = riskItems.filter(function(m) { return m.name.toLowerCase().indexOf(searchText) >= 0; });

  riskItems.sort(function(a, b) { return a.risk.remaining - b.risk.remaining; });

  var fifoCalcMap = {};
  riskItems.forEach(function(m) {
    if (!fifoCalcMap[m.name]) fifoCalcMap[m.name] = calcFIFODepletion(m.name);
  });

  var tbody = document.getElementById('riskTableBody');
  if (riskItems.length === 0) {
    tbody.innerHTML = '<tr><td colspan="12" style="text-align:center;padding:40px;color:var(--gray-400)">暂无风险材料数据，请先添加材料库�?/td></tr>';
    return;
  }

  tbody.innerHTML = riskItems.map(function(m) {
    var r = m.risk;
    var fifoCalc = fifoCalcMap[m.name];
    var bi = fifoCalc.batches.find(function(x) { return x.batch.id === m.id; });
    var weeksToExpiry = r.remaining / 7;
    var depleteVal = bi ? bi.depleteWeek : (r.weeksToDeplete || Infinity);
    var barPct = Math.min(100, weeksToExpiry > 0 ? (depleteVal / weeksToExpiry) * 100 : 100);
    var barColor = r.canFinish ? 'var(--success)' : 'var(--danger)';
    var badgeClass = { high: 'badge-danger', medium: 'badge-warning', low: 'badge-success' }[r.level];

    var finishLabel;
    if (r.weeklyAvg === 0) {
      finishLabel = 'No usage data';
    } else if (!bi) {
      finishLabel = r.canFinish ? 'OK - Finishable' : 'RISK - Will expire';
    } else if (bi.status === 'normal') {
      finishLabel = 'OK - Finishable';
    } else if (bi.status === 'partial_scrap') {
      finishLabel = '<span style="color:var(--warning)">Partial scrap: ' + bi.willScrapQty + ' ' + m.unit + ' (¥' + bi.willScrapValue.toFixed(0) + ')</span>';
    } else if (bi.status === 'scrap_before_use') {
      finishLabel = '<span style="color:var(--danger)">Full scrap ¥' + bi.willScrapValue.toFixed(0) + '</span>';
    } else {
      finishLabel = r.canFinish ? 'OK - Finishable' : 'RISK';
    }

    var remainingColor = r.remaining <= 30 ? 'var(--danger)' : (r.remaining <= 90 ? 'var(--warning)' : 'var(--gray-600)');
    var fifoOrder = bi ? bi.fifoRank : '-';
    var fifoNote = '';
    if (bi && bi.startWeek > 0) {
      fifoNote = '<div style="font-size:10px;color:var(--gray-400);margin-top:2px">Starts W' + bi.startWeek.toFixed(1) + '</div>';
    }

    return '<tr>' +
      '<td><span class="badge ' + badgeClass + '">' + r.label + '</span></td>' +
      '<td><a class="material-link" onclick="showDetail(\'' + m.id + '\')">' + m.name + '</a></td>' +
      '<td>' + m.batchNo + '</td>' +
      '<td>' + m.currentStock + ' ' + m.unit + '</td>' +
      '<td>' + formatDate(m.expiryDate) + '</td>' +
      '<td style="font-weight:600;color:' + remainingColor + '">' + r.remaining + '�?/td>' +
      '<td>' + (r.weeklyAvg > 0 ? r.weeklyAvg.toFixed(1) : '-') + '</td>' +
      '<td><div class="risk-bar"><div class="risk-bar-fill" style="width:' + Math.min(barPct, 100) + '%;background:' + barColor + '"></div></div> ' + (isFinite(depleteVal) ? depleteVal.toFixed(1) + 'w' : 'inf') + '</td>' +
      '<td style="font-weight:600">' + finishLabel + '</td>' +
      '<td><span class="badge ' + (fifoOrder === 1 ? 'badge-info' : 'badge-success') + '">#' + fifoOrder + '</span>' + fifoNote + '</td>' +
      '<td style="font-size:12px;color:var(--gray-600)">' + r.suggestion + '</td>' +
      '<td><button class="btn btn-outline btn-sm" onclick="showDetail(\'' + m.id + '\')">详情</button></td>' +
    '</tr>';
  }).join('');
}

function renderPredictions() {
  var container = document.getElementById('predictionContainer');
  var materials = loadData(STORAGE_KEY_MATERIALS);

  var materialSet = {};
  var materialNames = [];
  materials.forEach(function(m) {
    if (!materialSet[m.name]) { materialSet[m.name] = true; materialNames.push(m.name); }
  });

  if (materialNames.length === 0) {
    container.innerHTML = '<div style="text-align:center;padding:60px;color:var(--gray-400)">暂无数据，请先添加材料库�?/div>';
    return;
  }

  var predictions = materialNames.map(function(name) { return predict12Weeks(name); })
    .filter(function(p) { return p !== null; });

  predictions.sort(function(a, b) {
    if (a.hasRisk && !b.hasRisk) return -1;
    if (!a.hasRisk && b.hasRisk) return 1;
    if (a.scrapInfo.totalValue !== b.scrapInfo.totalValue) return b.scrapInfo.totalValue - a.scrapInfo.totalValue;
    if (a.stockoutInfo.week !== null && b.stockoutInfo.week !== null) return a.stockoutInfo.week - b.stockoutInfo.week;
    return 0;
  });

  container.innerHTML = predictions.map(function(p, idx) {
    return '<div class="prediction-card">' +
      '<div class="prediction-header">' +
        '<div class="prediction-title">' + p.materialName +
          (p.hasRisk ? '<span class="batch-tag batch-danger">At Risk</span>' : '<span class="batch-tag">Normal</span>') +
        '</div>' +
        '<div class="prediction-meta">' +
          '<span class="metric-inline"><span class="metric-dot" style="background:var(--primary)"></span>Weekly: ' + p.weeklyUsage.toFixed(1) + ' ' + p.unit + '</span>' +
          (p.scrapInfo.totalQty > 0 ? '<span class="metric-inline"><span class="metric-dot" style="background:var(--danger)"></span>Scrap: ' + p.scrapInfo.totalQty + ' ' + p.unit + ' (¥' + p.scrapInfo.totalValue.toFixed(0) + ')</span>' : '') +
          (p.stockoutInfo.week !== null ? '<span class="metric-inline"><span class="metric-dot" style="background:var(--warning)"></span>Stockout Wk' + p.stockoutInfo.week + '</span>' : '') +
        '</div>' +
      '</div>' +
      '<div style="position:relative;height:220px"><canvas id="predChart_' + idx + '"></canvas></div>' +
    '</div>';
  }).join('');

  setTimeout(function() {
    predictions.forEach(function(p, idx) {
      var canvasId = 'predChart_' + idx;
      if (chartInstances[canvasId]) chartInstances[canvasId].destroy();

      var colors = ['#2563eb', '#f59e0b', '#10b981', '#8b5cf6', '#ec4899'];

      var datasets = [{
        label: 'Projected Stock',
        data: p.stockLevels,
        borderColor: colors[0],
        backgroundColor: colors[0] + '20',
        fill: true,
        tension: 0.2,
        borderWidth: 2,
        pointRadius: 2
      }];

      var annotations = [];

      p.events.forEach(function(ev) {
        if (ev.type === 'scrap') {
          datasets.push({
            label: 'Scrap (' + ev.batchNo + ')',
            data: p.stockLevels.map(function(_, i) { return i === ev.week ? p.stockLevels[ev.week] : null; }),
            borderColor: 'var(--danger)',
            backgroundColor: 'var(--danger)',
            pointRadius: 6,
            pointStyle: 'triangle',
            showLine: false
          });
        }
      });

      if (p.stockoutInfo.week !== null) {
        datasets.push({
          label: 'Stockout',
          data: p.stockLevels.map(function(_, i) { return i === p.stockoutInfo.week ? 0 : null; }),
          borderColor: 'var(--warning)',
          backgroundColor: 'var(--warning)',
          pointRadius: 6,
          pointStyle: 'rectRot',
          showLine: false
        });
      }

      chartInstances[canvasId] = new Chart(document.getElementById(canvasId), {
        type: 'line',
        data: { labels: p.weekLabels, datasets: datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } },
            tooltip: {
              callbacks: {
                label: function(ctx) {
                  return ctx.dataset.label + ': ' + ctx.parsed.y.toFixed(1) + ' ' + p.unit;
                }
              }
            }
          },
          scales: {
            y: { beginAtZero: true, title: { display: true, text: 'Stock (' + p.unit + ')', font: { size: 11 } } },
            x: { title: { display: true, text: 'Weeks Ahead', font: { size: 11 } } }
          }
        }
      });
    });
  }, 100);
}

function switchWeeklySort(sortBy) {
  weeklySortBy = sortBy;
  document.getElementById('sortByStockout').className = sortBy === 'stockout' ? 'btn btn-primary btn-sm' : 'btn btn-outline btn-sm';
  document.getElementById('sortByScrap').className = sortBy === 'scrap' ? 'btn btn-primary btn-sm' : 'btn btn-outline btn-sm';
  renderWeeklyMeeting();
}

function getWeeklyMeetingData() {
  var materials = loadData(STORAGE_KEY_MATERIALS);
  var materialSet = {};
  var materialNames = [];
  materials.forEach(function(m) {
    if (!materialSet[m.name]) { materialSet[m.name] = true; materialNames.push(m.name); }
  });
  var planMap = getLatestPlanByMaterial();

  var items = materialNames.map(function(name) {
    var p = predict12Weeks(name);
    if (!p) return null;

    var sim = simulateConsumption(name, p.weeklyUsage, 0, null);
    var fifo = getFIFOBatches(name);
    var totalStock = fifo.reduce(function(s, b) { return s + b.currentStock; }, 0);
    var fifoCalc = calcFIFODepletion(name);

    var group, groupOrder;
    var hasNearExpiry = fifo.some(function(b) { return daysBetween(today(), b.expiryDate) <= 30; });
    var hasMidExpiry = fifo.some(function(b) { var d = daysBetween(today(), b.expiryDate); return d > 30 && d <= 90; });
    var stockoutWeek = p.stockoutInfo.week;
    var scrapValue = p.scrapInfo.totalValue;
    var scrapQty = p.scrapInfo.totalQty;

    if (scrapValue > 0 && (stockoutWeek === null || stockoutWeek > 8)) {
      group = 'suspend';
      groupOrder = 1;
    } else if (scrapValue > 0 && stockoutWeek !== null && stockoutWeek <= 8) {
      group = 'reduce';
      groupOrder = 2;
    } else if (stockoutWeek !== null && stockoutWeek < 4) {
      group = 'restock';
      groupOrder = 4;
    } else if (stockoutWeek !== null && stockoutWeek <= 8) {
      group = 'plan';
      groupOrder = 3;
    } else if (hasNearExpiry) {
      group = 'prioritize';
      groupOrder = 5;
    } else {
      group = 'normal';
      groupOrder = 6;
    }

    return {
      name: name,
      group: group,
      groupOrder: groupOrder,
      totalStock: totalStock,
      unit: p.unit,
      weeklyUsage: p.weeklyUsage,
      stockoutWeek: stockoutWeek,
      stockoutDate: p.stockoutInfo.date,
      scrapQty: scrapQty,
      scrapValue: scrapValue,
      batches: fifo.length,
      hasNearExpiry: hasNearExpiry,
      hasMidExpiry: hasMidExpiry,
      prediction: p,
      fifoCalc: fifoCalc,
      impactWeeks: stockoutWeek !== null ? Math.max(0, 12 - stockoutWeek) : 0,
      recoverableValue: scrapValue,
      plan: planMap[name] || null
    };
  }).filter(function(x) { return x !== null; });

  var groups = {
    suspend: { title: 'Suspend Purchase', desc: 'Scrap risk, digest stock first', items: [] },
    reduce: { title: 'Reduce Qty', desc: 'Need restock but reduce quantity', items: [] },
    plan: { title: 'Plan Purchase', desc: 'Stock OK, schedule purchase', items: [] },
    restock: { title: 'Restock ASAP', desc: 'Stock low, need soon', items: [] },
    prioritize: { title: 'Prioritize Usage', desc: 'Near-expiry batches, speed up', items: [] },
    normal: { title: 'Normal Mgmt', desc: 'Stock and expiry normal', items: [] }
  };

  items.forEach(function(item) {
    if (groups[item.group]) {
      groups[item.group].items.push(item);
    }
  });

  Object.keys(groups).forEach(function(key) {
    var g = groups[key];
    g.totalItems = g.items.length;
    g.totalScrapValue = g.items.reduce(function(s, it) { return s + it.scrapValue; }, 0);
    g.totalScrapQty = g.items.reduce(function(s, it) { return s + it.scrapQty; }, 0);
    g.avgImpactWeeks = g.totalItems > 0
      ? (g.items.reduce(function(s, it) { return s + it.impactWeeks; }, 0) / g.totalItems)
      : 0;
    g.stockoutIn4w = g.items.filter(function(it) { return it.stockoutWeek !== null && it.stockoutWeek < 4; }).length;
    g.stockoutIn8w = g.items.filter(function(it) { return it.stockoutWeek !== null && it.stockoutWeek < 8; }).length;
    g.pendingPlans = g.items.filter(function(it) { return it.plan && it.plan.status === 'pending'; }).length;
    g.approvedPlans = g.items.filter(function(it) { return it.plan && it.plan.status === 'approved'; }).length;

    g.items.sort(function(a, b) {
      if (weeklySortBy === 'stockout') {
        if (a.stockoutWeek !== null && b.stockoutWeek !== null) return a.stockoutWeek - b.stockoutWeek;
        if (a.stockoutWeek !== null && b.stockoutWeek === null) return -1;
        if (a.stockoutWeek === null && b.stockoutWeek !== null) return 1;
        return b.scrapValue - a.scrapValue;
      } else {
        if (a.scrapValue !== b.scrapValue) return b.scrapValue - a.scrapValue;
        if (a.stockoutWeek !== null && b.stockoutWeek !== null) return a.stockoutWeek - b.stockoutWeek;
        if (a.stockoutWeek !== null && b.stockoutWeek === null) return -1;
        if (a.stockoutWeek === null && b.stockoutWeek !== null) return 1;
        return 0;
      }
    });
  });

  return groups;
}

function renderWeeklyMeeting() {
  var container = document.getElementById('weeklyMeetingContainer');
  var groups = getWeeklyMeetingData();
  var statusColors = { pending: 'warning', approved: 'success', delayed: 'info', modified: 'primary', cancelled: 'danger' };
  var statusLabels = { pending: 'Pending', approved: 'Approved', delayed: 'Delayed', modified: 'Modified', cancelled: 'Cancelled' };

  var groupColors = {
    suspend: 'danger',
    reduce: 'warning',
    plan: 'info',
    restock: 'success',
    prioritize: 'warning',
    normal: 'gray'
  };

  var groupIcons = {
    suspend: '[X]',
    reduce: '[~]',
    plan: '[>]',
    restock: '[!]',
    prioritize: '[!]',
    normal: '[✓]'
  };

  var html = '';
  var totalItems = 0;
  var totalScrapValue = 0;
  var stockoutCount = 0;
  var pendingPlans = 0;
  var approvedPlans = 0;

  Object.keys(groups).forEach(function(key) {
    var g = groups[key];
    totalItems += g.items.length;
    pendingPlans += g.pendingPlans;
    approvedPlans += g.approvedPlans;
    g.items.forEach(function(item) {
      totalScrapValue += item.scrapValue;
      if (item.stockoutWeek !== null && item.stockoutWeek < 12) stockoutCount++;
    });
  });

  html += '<div class="weekly-stats" style="display:grid;grid-template-columns:repeat(6,1fr);gap:10px;margin-bottom:20px">' +
    '<div class="stat-card" style="padding:12px;background:var(--danger-light);border-radius:8px">' +
      '<div style="font-size:10px;color:var(--danger);text-transform:uppercase;letter-spacing:.5px">Scrap Risk</div>' +
      '<div style="font-size:20px;font-weight:700;color:var(--danger)">¥' + totalScrapValue.toFixed(0) + '</div>' +
    '</div>' +
    '<div class="stat-card" style="padding:12px;background:var(--warning-light);border-radius:8px">' +
      '<div style="font-size:10px;color:var(--warning);text-transform:uppercase;letter-spacing:.5px">Stockout 12w</div>' +
      '<div style="font-size:20px;font-weight:700;color:var(--warning)">' + stockoutCount + '</div>' +
    '</div>' +
    '<div class="stat-card" style="padding:12px;background:#fde68a;border-radius:8px">' +
      '<div style="font-size:10px;color:#92400e;text-transform:uppercase;letter-spacing:.5px">Pending Plans</div>' +
      '<div style="font-size:20px;font-weight:700;color:#92400e">' + pendingPlans + '</div>' +
    '</div>' +
    '<div class="stat-card" style="padding:12px;background:#bbf7d0;border-radius:8px">' +
      '<div style="font-size:10px;color:#166534;text-transform:uppercase;letter-spacing:.5px">Approved</div>' +
      '<div style="font-size:20px;font-weight:700;color:#166534">' + approvedPlans + '</div>' +
    '</div>' +
    '<div class="stat-card" style="padding:12px;background:#e0e7ff;border-radius:8px">' +
      '<div style="font-size:10px;color:#3730a3;text-transform:uppercase;letter-spacing:.5px">Materials</div>' +
      '<div style="font-size:20px;font-weight:700;color:#3730a3">' + totalItems + '</div>' +
    '</div>' +
    '<div class="stat-card" style="padding:12px;background:#cffafe;border-radius:8px">' +
      '<div style="font-size:10px;color:#155e75;text-transform:uppercase;letter-spacing:.5px">View Mode</div>' +
      '<div style="font-size:16px;font-weight:700;color:#155e75">' + (weeklySortBy === 'stockout' ? 'Stockout 1st' : 'Scrap Value 1st') + '</div>' +
    '</div>' +
  '</div>';

  Object.keys(groups).forEach(function(key) {
    var g = groups[key];
    if (g.items.length === 0) return;

    var color = groupColors[key];
    var icon = groupIcons[key];
    var summaryMetrics;
    if (weeklySortBy === 'stockout') {
      summaryMetrics = '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;font-size:11px">' +
        '<div style="padding:6px 8px;background:#fff;border-radius:4px;text-align:center">' +
          '<div style="color:var(--gray-500)">Stockout <4w</div>' +
          '<div style="font-size:15px;font-weight:700;color:var(--danger)">' + g.stockoutIn4w + '</div>' +
        '</div>' +
        '<div style="padding:6px 8px;background:#fff;border-radius:4px;text-align:center">' +
          '<div style="color:var(--gray-500)">Stockout <8w</div>' +
          '<div style="font-size:15px;font-weight:700;color:var(--warning)">' + g.stockoutIn8w + '</div>' +
        '</div>' +
        '<div style="padding:6px 8px;background:#fff;border-radius:4px;text-align:center">' +
          '<div style="color:var(--gray-500)">Avg Impact Weeks</div>' +
          '<div style="font-size:15px;font-weight:700;color:#4f46e5">' + g.avgImpactWeeks.toFixed(1) + 'w</div>' +
        '</div>' +
      '</div>';
    } else {
      summaryMetrics = '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;font-size:11px">' +
        '<div style="padding:6px 8px;background:#fff;border-radius:4px;text-align:center">' +
          '<div style="color:var(--gray-500)">Scrap Amount</div>' +
          '<div style="font-size:15px;font-weight:700;color:var(--danger)">¥' + g.totalScrapValue.toFixed(0) + '</div>' +
        '</div>' +
        '<div style="padding:6px 8px;background:#fff;border-radius:4px;text-align:center">' +
          '<div style="color:var(--gray-500)">Scrap Qty</div>' +
          '<div style="font-size:15px;font-weight:700;color:var(--warning)">' + g.totalScrapQty.toFixed(0) + '</div>' +
        '</div>' +
        '<div style="padding:6px 8px;background:#fff;border-radius:4px;text-align:center">' +
          '<div style="color:var(--gray-500)">Recoverable</div>' +
          '<div style="font-size:15px;font-weight:700;color:#16a34a">¥' + g.totalScrapValue.toFixed(0) + '</div>' +
        '</div>' +
      '</div>';
    }

    var planBadges = '';
    if (g.pendingPlans > 0) planBadges += '<span class="badge badge-warning" style="margin-left:8px">' + g.pendingPlans + ' pending</span>';
    if (g.approvedPlans > 0) planBadges += '<span class="badge badge-success" style="margin-left:6px">' + g.approvedPlans + ' approved</span>';

    html += '<div class="weekly-group" style="margin-bottom:20px">' +
      '<div class="group-header" style="padding:12px 14px;background:var(--gray-50);border-radius:8px 8px 0 0;border:1px solid var(--gray-200);border-bottom:none">' +
        '<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">' +
          '<span style="font-weight:700;font-size:14px;color:var(--gray-800)">' + icon + ' ' + g.title + '</span>' +
          '<span class="badge badge-' + color + '" style="font-size:11px">' + g.items.length + ' items</span>' +
          planBadges +
          '<span style="font-size:12px;color:var(--gray-500);margin-left:auto">' + g.desc + '</span>' +
        '</div>' +
        summaryMetrics +
      '</div>' +
      '<div class="group-body" style="border:1px solid var(--gray-200);border-top:none;border-radius:0 0 8px 8px;overflow:hidden">' +
        '<table style="width:100%;border-collapse:collapse">' +
          '<thead>' +
            '<tr style="background:var(--gray-50)">' +
              '<th style="text-align:left;padding:8px 12px;font-size:12px;font-weight:600;color:var(--gray-600)">Material</th>' +
              (weeklySortBy === 'stockout'
                ? '<th style="text-align:right;padding:8px 12px;font-size:12px;font-weight:600;color:var(--gray-600)">Stockout Time</th>' +
                  '<th style="text-align:right;padding:8px 12px;font-size:12px;font-weight:600;color:var(--gray-600)">Impact (wks)</th>'
                : '<th style="text-align:right;padding:8px 12px;font-size:12px;font-weight:600;color:var(--gray-600)">Scrap Value</th>' +
                  '<th style="text-align:right;padding:8px 12px;font-size:12px;font-weight:600;color:var(--gray-600)">Scrap Qty</th>') +
              '<th style="text-align:right;padding:8px 12px;font-size:12px;font-weight:600;color:var(--gray-600)">Stock / Usage</th>' +
              '<th style="text-align:center;padding:8px 12px;font-size:12px;font-weight:600;color:var(--gray-600)">Plan</th>' +
            '</tr>' +
          '</thead>' +
          '<tbody>';

    g.items.forEach(function(item, idx) {
      var planCell;
      if (item.plan) {
        var pc = statusColors[item.plan.status] || 'gray';
        var pl = statusLabels[item.plan.status] || item.plan.status;
        planCell = '<span class="badge badge-' + pc + '" style="cursor:pointer" onclick="event.stopPropagation();openPlanQuickModal(\'' + item.plan.id + '\')" title="Click to update">' + pl + '</span>';
      } else {
        planCell = '<span style="color:var(--gray-400);font-size:11px">n/a</span>';
      }

      var stockoutCell = '';
      if (weeklySortBy === 'stockout') {
        var stockoutText = item.stockoutWeek !== null
          ? ('W' + item.stockoutWeek + '<br><span style="font-size:10px;color:var(--gray-500)">' + formatDate(item.stockoutDate) + '</span>')
          : '<span style="color:var(--gray-400)">>12w</span>';
        var stockoutColor = item.stockoutWeek !== null && item.stockoutWeek < 4 ? 'var(--danger)'
          : (item.stockoutWeek !== null && item.stockoutWeek < 8 ? 'var(--warning)' : 'var(--gray-500)');
        stockoutCell =
          '<td style="padding:10px 12px;font-size:13px;text-align:right;font-weight:600;color:' + stockoutColor + '">' + stockoutText + '</td>' +
          '<td style="padding:10px 12px;font-size:13px;text-align:right;font-weight:700">' +
            (item.stockoutWeek !== null && item.stockoutWeek < 12
              ? '<span style="color:var(--warning)">' + item.impactWeeks + 'w affected</span>'
              : '<span style="color:var(--gray-400)">-</span>') +
          '</td>';
      } else {
        var scrapText = item.scrapValue > 0
          ? ('<span style="color:var(--danger);font-weight:700">¥' + item.scrapValue.toFixed(0) + '</span>')
          : '<span style="color:var(--gray-400)">-</span>';
        var scrapQty = item.scrapValue > 0
          ? ('<span style="color:var(--warning)">' + item.scrapQty.toFixed(0) + ' ' + item.unit + '</span>')
          : '<span style="color:var(--gray-400)">-</span>';
        stockoutCell =
          '<td style="padding:10px 12px;font-size:13px;text-align:right">' + scrapText + '</td>' +
          '<td style="padding:10px 12px;font-size:13px;text-align:right">' + scrapQty + '</td>';
      }

      html += '<tr style="border-top:1px solid var(--gray-100);cursor:pointer" onclick="showDetailByName(\'' + item.name + '\')">' +
        '<td style="padding:10px 12px;font-size:13px;font-weight:500;color:var(--gray-800)">' +
          item.name +
          (item.hasNearExpiry ? ' <span title="Has near-expiry batch" style="color:var(--danger);font-size:11px">[!]</span>' : '') +
        '</td>' +
        stockoutCell +
        '<td style="padding:10px 12px;font-size:12px;text-align:right;color:var(--gray-600)">' +
          item.totalStock + ' ' + item.unit + '<br>' +
          '<span style="color:var(--gray-400)">' + item.weeklyUsage.toFixed(1) + '/wk</span>' +
        '</td>' +
        '<td style="padding:10px 12px;text-align:center">' + planCell + '</td>' +
      '</tr>';
    });

    html += '</tbody></table></div></div>';
  });

  container.innerHTML = html;
}

function showDetailByName(name) {
  var fifo = getFIFOBatches(name);
  if (fifo.length > 0) {
    showDetail(fifo[0].id);
  }
}

function showDetail(id) {
  var materials = loadData(STORAGE_KEY_MATERIALS);
  var m = materials.find(function(x) { return x.id === id; });
  if (!m) return;
  var r = assessBatchRisk(m);

  var allBatches = getFIFOBatches(m.name);
  var fifoOrder = allBatches.findIndex(function(b) { return b.id === m.id; }) + 1;

  var sim = simulateConsumption(m.name, r.weeklyAvg, 0, null);

  document.getElementById('detailModalTitle').textContent = m.name + ' �?批次' + m.batchNo + ' 详细分析';

  var usages = loadData(STORAGE_KEY_USAGES).filter(function(u) { return u.materialId === m.id || u.materialName === m.name; });
  var byDoctor = getWeeklyAvgByDoctor(m.name);
  var byDept = getWeeklyAvgByDept(m.name);
  var trend = getWeeklyTrendByDoctor(m.name);

  var suggestions = [];
  if (r.remaining <= 0) {
    suggestions.push({ icon: '[X]', title: 'Remove Immediately', desc: 'This batch has expired. Stop using it immediately and dispose of properly.', color: 'var(--danger)' });
  }
  if (fifoOrder === 1 && r.remaining > 0 && r.remaining <= 60) {
    suggestions.push({ icon: '[!]', title: 'Prioritize Usage', desc: 'This is FIFO #1. Recommend using it first in clinical practice.', color: 'var(--warning)' });
  }
  if (fifoOrder > 1) {
    suggestions.push({ icon: '[>]', title: 'Wait in FIFO Queue', desc: 'FIFO #' + fifoOrder + '. Need to consume ' + (fifoOrder-1) + ' earlier batches first.', color: 'var(--primary)' });
  }
  if (!r.canFinish && r.weeklyAvg > 0) {
    suggestions.push({ icon: '[=]', title: 'Suspend Purchase', desc: 'At current consumption (' + r.weeklyAvg.toFixed(1) + '/wk), this batch cannot be fully used before expiry.', color: 'var(--warning)' });
    suggestions.push({ icon: '[<->]', title: 'Store Transfer', desc: 'Consider transferring excess stock to a higher consumption location or department.', color: 'var(--primary)' });
  }
  if (sim.totalScrappedQty > 0) {
    suggestions.push({ icon: '[$]', title: 'Projected Scrap: ' + sim.totalScrappedQty + ' ' + m.unit, desc: 'FIFO simulation shows ¥' + sim.totalScrappedValue.toFixed(2) + ' loss. Immediate intervention recommended.', color: 'var(--danger)' });
  }
  if (sim.stockoutWeek !== null) {
    suggestions.push({ icon: '[?]', title: 'Stockout Wk' + sim.stockoutWeek, desc: 'No available stock after ' + sim.stockoutDate + '. Recommend timely replenishment.', color: 'var(--warning)' });
  }
  if (r.remaining > 0 && r.remaining <= 30 && r.weeklyAvg === 0) {
    suggestions.push({ icon: '[↻]', title: 'Supplier Exchange', desc: 'No consumption in 8 weeks and expiring soon. Recommend contacting supplier for exchange.', color: 'var(--warning)' });
  }
  if (r.canFinish && r.level === 'low' && fifoOrder === 1) {
    suggestions.push({ icon: '[✓]', title: 'Normal Usage', desc: 'At current consumption rate, can be fully used before expiry.', color: 'var(--success)' });
  }

  var remainingColor = r.remaining <= 30 ? 'var(--danger)' : (r.remaining <= 90 ? 'var(--warning)' : 'var(--success)');

  var allBatchesHtml = '';
  if (allBatches.length > 1) {
    var fifoCalc = calcFIFODepletion(m.name);
    allBatchesHtml = '<div style="margin-top:16px"><h4 style="font-size:14px;font-weight:600;margin-bottom:10px">Other Batches (FIFO Order)</h4>' +
      '<div class="usage-table"><table><thead><tr><th>Priority</th><th>Batch No.</th><th>Stock</th><th>Expiry</th><th>Days Left</th><th>Starts</th><th>Depletes</th></tr></thead><tbody>' +
      fifoCalc.batches.map(function(bi, idx) {
        var b = bi.batch;
        var badge = idx + 1 === fifoOrder ? '<span class="fifo-badge">Current</span>' : '';
        var days = daysBetween(today(), b.expiryDate);
        var col = days <= 30 ? 'var(--danger)' : (days <= 90 ? 'var(--warning)' : 'inherit');
        var depleteText;
        if (bi.status === 'normal') {
          depleteText = (isFinite(bi.depleteWeek) ? 'W' + bi.depleteWeek.toFixed(1) : 'inf');
        } else if (bi.status === 'partial_scrap') {
          depleteText = '<span style="color:var(--warning)">partial</span>';
        } else if (bi.status === 'scrap_before_use') {
          depleteText = '<span style="color:var(--danger)">scrap</span>';
        } else {
          depleteText = bi.status;
        }
        return '<tr' + (idx + 1 === fifoOrder ? ' style="background:var(--primary-light)"' : '') + '>' +
          '<td>#' + (idx + 1) + badge + '</td>' +
          '<td>' + b.batchNo + '</td>' +
          '<td>' + b.currentStock + ' ' + b.unit + '</td>' +
          '<td>' + formatDate(b.expiryDate) + '</td>' +
          '<td style="color:' + col + '">' + days + 'd</td>' +
          '<td>W' + (isFinite(bi.startWeek) ? bi.startWeek.toFixed(1) : '-') + '</td>' +
          '<td>' + depleteText + '</td>' +
        '</tr>';
      }).join('') +
      '</tbody></table></div></div>';
  }

  var simTimeline = '';
  if (sim.events.length > 0) {
    simTimeline = '<div class="sim-timeline">' +
      '<h5>[=] Consumption Simulation (FIFO)</h5>' +
      sim.events.map(function(ev) {
        var typeBadge = '';
        if (ev.type === 'scrap') typeBadge = '<span class="badge badge-danger">Scrap</span>';
        if (ev.type === 'deplete') typeBadge = '<span class="badge badge-info">Depleted</span>';
        if (ev.type === 'stockout') typeBadge = '<span class="badge badge-warning">Stockout</span>';
        return '<div class="sim-event">' +
          '<span class="sim-date">' + formatDate(ev.date) + '</span>' +
          '<span class="sim-type">' + typeBadge + '</span>' +
          '<span class="sim-desc">' + ev.desc + '</span>' +
        '</div>';
      }).join('') +
    '</div>';
  }

  var html =
    '<div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:12px;margin-bottom:20px">' +
      '<div style="background:var(--gray-50);padding:12px;border-radius:8px;text-align:center">' +
        '<div style="font-size:12px;color:var(--gray-500)">Current Stock</div>' +
        '<div style="font-size:20px;font-weight:700">' + m.currentStock + ' ' + m.unit + '</div>' +
      '</div>' +
      '<div style="background:var(--gray-50);padding:12px;border-radius:8px;text-align:center">' +
        '<div style="font-size:12px;color:var(--gray-500)">Expiry Date</div>' +
        '<div style="font-size:20px;font-weight:700;color:' + (r.remaining<=30?'var(--danger)':'var(--gray-800)') + '">' + formatDate(m.expiryDate) + '</div>' +
      '</div>' +
      '<div style="background:var(--gray-50);padding:12px;border-radius:8px;text-align:center">' +
        '<div style="font-size:12px;color:var(--gray-500)">Days Left</div>' +
        '<div style="font-size:20px;font-weight:700;color:' + remainingColor + '">' + r.remaining + 'd</div>' +
      '</div>' +
      '<div style="background:var(--gray-50);padding:12px;border-radius:8px;text-align:center">' +
        '<div style="font-size:12px;color:var(--gray-500)">FIFO Priority</div>' +
        '<div style="font-size:20px;font-weight:700;color:var(--primary)">#' + fifoOrder + '</div>' +
      '</div>' +
    '</div>' +
    '<div class="charts-row">' +
      '<div class="chart-box"><h4>8-Week Usage Trend by Doctor</h4><canvas id="detailDoctorChart" height="220"></canvas></div>' +
      '<div class="chart-box"><h4>Consumption by Department</h4><canvas id="detailDeptChart" height="220"></canvas></div>' +
    '</div>' +
    '<div style="margin-bottom:16px">' +
      '<h4 style="font-size:14px;font-weight:600;margin-bottom:10px">Recommended Actions</h4>' +
      '<div class="action-cards">' +
        suggestions.map(function(s) {
          return '<div class="action-card">' +
            '<div class="action-icon" style="background:' + s.color + '20;color:' + s.color + '">' + s.icon + '</div>' +
            '<div class="action-title">' + s.title + '</div>' +
            '<div class="action-desc">' + s.desc + '</div>' +
          '</div>';
        }).join('') +
      '</div>' +
    '</div>' +
    simTimeline +
    allBatchesHtml +
    '<div style="margin-top:16px">' +
      '<h4 style="font-size:14px;font-weight:600;margin-bottom:10px">Recent Usage Records</h4>' +
      (usages.length === 0 ? '<p style="color:var(--gray-400);font-size:13px">No usage records</p>' :
        '<div class="usage-table"><table><thead><tr><th>Date</th><th>Batch</th><th>Qty</th><th>Doctor</th><th>Dept</th><th>Treatment</th></tr></thead><tbody>' +
        usages.sort(function(a,b){return new Date(b.date)-new Date(a.date)}).slice(0,20).map(function(u) {
          return '<tr><td>' + formatDate(u.date) + '</td><td>' + (u.batchNo || '-') + '</td><td>' + u.quantity + '</td><td>' + u.doctor + '</td><td>' + u.department + '</td><td>' + u.treatment + '</td></tr>';
        }).join('') +
        '</tbody></table></div>'
      ) +
    '</div>';

  document.getElementById('detailModalBody').innerHTML = html;
  openModal('detailModal');

  setTimeout(function() {
    if (chartInstances.detailDoctor) chartInstances.detailDoctor.destroy();
    if (chartInstances.detailDept) chartInstances.detailDept.destroy();

    var colors = ['#2563eb','#f59e0b','#10b981','#ef4444','#8b5cf6','#ec4899'];
    var doctorDatasets = trend.doctors.map(function(doc, i) {
      return {
        label: doc,
        data: trend.weeks.map(function(w) { return w[doc] || 0; }),
        borderColor: colors[i % colors.length],
        backgroundColor: colors[i % colors.length] + '20',
        fill: false,
        tension: 0.3,
        borderWidth: 2,
        pointRadius: 3
      };
    });

    chartInstances.detailDoctor = new Chart(document.getElementById('detailDoctorChart'), {
      type: 'line',
      data: { labels: trend.weeks.map(function(w) { return w.label; }), datasets: doctorDatasets },
      options: {
        responsive: true,
        plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } } },
        scales: { y: { beginAtZero: true, title: { display: true, text: '数量', font: { size: 11 } } } }
      }
    });

    var deptLabels = Object.keys(byDept);
    var deptData = Object.values(byDept);
    chartInstances.detailDept = new Chart(document.getElementById('detailDeptChart'), {
      type: 'doughnut',
      data: {
        labels: deptLabels,
        datasets: [{ data: deptData, backgroundColor: colors.slice(0, deptLabels.length) }]
      },
      options: {
        responsive: true,
        plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } } }
      }
    });
  }, 100);
}

function renderVerify() {
  var materials = loadData(STORAGE_KEY_MATERIALS);
  var nameSet = {};
  var names = [];
  materials.forEach(function(m) {
    if (!nameSet[m.name]) { nameSet[m.name] = true; names.push(m.name); }
  });
  var sel = document.getElementById('verifyMaterial');
  sel.innerHTML = '<option value="">请选择�?/option>' + names.map(function(n) {
    return '<option value="' + n + '">' + n + '</option>';
  }).join('');

  document.getElementById('verifyResult').innerHTML = '';
  document.getElementById('verifyStockBody').innerHTML = '';
}

function onVerifyMaterialChange() {
  var name = document.getElementById('verifyMaterial').value;
  if (!name) {
    document.getElementById('verifyWeeklyUsage').value = '';
    document.getElementById('verifyStockBody').innerHTML = '';
    document.getElementById('verifyResult').innerHTML = '';
    return;
  }

  var fifoCalc = calcFIFODepletion(name);
  document.getElementById('verifyWeeklyUsage').value = fifoCalc.weeklyAvg > 0 ? fifoCalc.weeklyAvg.toFixed(1) : '';

  document.getElementById('verifyStockBody').innerHTML = fifoCalc.batches.map(function(bi) {
    var b = bi.batch;
    var remaining = daysBetween(today(), b.expiryDate);
    var remainingColor = remaining <= 30 ? 'var(--danger)' : (remaining <= 90 ? 'var(--warning)' : 'inherit');
    var priority = bi.idx === 0 ? '<span class="badge badge-info">#1</span>' : '<span class="badge badge-success">#' + bi.fifoRank + '</span>';

    var depleteNote;
    if (bi.status === 'normal') {
      depleteNote = (isFinite(bi.depleteWeek) ? bi.depleteWeek.toFixed(1) + 'w' : 'inf');
    } else if (bi.status === 'partial_scrap') {
      depleteNote = '<span style="color:var(--warning)">partial scrap</span>';
    } else if (bi.status === 'scrap_before_use') {
      depleteNote = '<span style="color:var(--danger)">expires before use</span>';
    } else if (bi.status === 'no_usage_data') {
      depleteNote = '<span style="color:var(--gray-400)">no usage data</span>';
    } else {
      depleteNote = '<span style="color:var(--danger)">expired</span>';
    }

    return '<tr>' +
      '<td>' + priority + '</td>' +
      '<td>' + b.batchNo + '</td>' +
      '<td>' + b.currentStock + ' ' + b.unit + '</td>' +
      '<td>' + formatDate(b.expiryDate) + '</td>' +
      '<td style="color:' + remainingColor + '">' + remaining + 'd</td>' +
      '<td>' + (fifoCalc.weeklyAvg > 0 ? fifoCalc.weeklyAvg.toFixed(1) : '-') + '</td>' +
      '<td>' + depleteNote + '</td>' +
    '</tr>';
  }).join('');

  runSimulation();
}

function runSimulation() {
  var name = document.getElementById('verifyMaterial').value;
  var qty = parseFloat(document.getElementById('verifyQty').value) || 0;
  var expiry = document.getElementById('verifyExpiry').value;
  var weeklyUsage = parseFloat(document.getElementById('verifyWeeklyUsage').value) || 0;

  if (!name || qty <= 0) {
    document.getElementById('verifyResult').innerHTML = '';
    return;
  }

  var fifo = getFIFOBatches(name);
  if (fifo.length === 0) {
    document.getElementById('verifyResult').innerHTML =
      '<div class="verify-result warn"><h4>⚠️ No Existing Stock</h4>' +
      '<div class="detail">No existing stock for "' + name + '". Please confirm if base stock needs to be established.</div></div>';
    return;
  }

  var unit = fifo[0].unit;
  var totalExisting = fifo.reduce(function(s, b) { return s + b.currentStock; }, 0);
  var newBatchExpiry = expiry || addDays(today(), 365);
  var sim = simulateConsumption(name, weeklyUsage, qty, newBatchExpiry);
  var simWithoutNew = simulateConsumption(name, weeklyUsage, 0, null);

  var scrapDiff = sim.totalScrappedValue - simWithoutNew.totalScrappedValue;
  var hasOldBatchRisk = fifo.some(function(b) {
    var remaining = daysBetween(today(), b.expiryDate);
    return remaining <= 90 && b.currentStock > 0;
  });

  var fifoWithNew = sim.allBatches;
  var newBatchPosition = fifoWithNew.findIndex(function(b) { return b.isNew; }) + 1;

  var oldBatchesNearExpiry = fifo.filter(function(b) {
    return daysBetween(today(), b.expiryDate) <= 90 && b.currentStock > 0;
  });

  var html = '';
  var resultType = 'pass';

  if (weeklyUsage <= 0) {
    resultType = 'warn';
    html = '<div class="verify-result warn">' +
      '<h4>⚠️ Insufficient Usage Data</h4>' +
      '<div class="detail">' +
        'No usage data in past 8 weeks for "' + name + '". Cannot accurately assess purchase decision.<br>' +
        'Current stock: <strong>' + totalExisting + ' ' + unit + '</strong>, after purchase: <strong>' + (totalExisting + qty) + ' ' + unit + '</strong>.<br>' +
        'Please add usage records or purchase cautiously.' +
      '</div>' +
    '</div>';
  } else if (scrapDiff > 0) {
    resultType = 'block';
    var weeksToUseOld = simWithoutNew.stockoutWeek !== null ? simWithoutNew.stockoutWeek : 'inf';
    var suggestedQty = Math.max(0, Math.floor(weeklyUsage * Math.max(0, 2 - weeksToUseOld)));
    html = '<div class="verify-result block">' +
      '<h4>[X] Overstock Risk - NOT recommended</h4>' +
      '<div class="detail">' +
        'Proposed purchase: <strong>' + qty + ' ' + unit + '</strong>, new batch expiry: <strong>' + formatDate(newBatchExpiry) + '</strong>.<br>' +
        'FIFO priority: <strong>#' + newBatchPosition + '</strong>, need to consume ' + (newBatchPosition-1) + ' older batches first.<br><br>' +
        '<strong>Analysis:</strong><br>' +
        '�?Projected additional scrap: <strong style="color:var(--danger)">¥' + scrapDiff.toFixed(2) + '</strong> (total scrap ¥' + sim.totalScrappedValue.toFixed(2) + ')<br>' +
        '�?Additional scrap quantity: <strong>' + (sim.totalScrappedQty - simWithoutNew.totalScrappedQty) + ' ' + unit + '</strong><br>' +
        (oldBatchesNearExpiry.length > 0 ?
          '�?Near-expiry batches not consumed: ' + oldBatchesNearExpiry.map(function(b) {
            return 'Batch "' + b.batchNo + '" (' + b.currentStock + ' ' + unit + ', ' + daysBetween(today(), b.expiryDate) + 'd left)';
          }).join(', ') + '<br>' : '') +
        '<br>' +
        '<strong>[!] Recommendations:</strong><br>' +
        (oldBatchesNearExpiry.length > 0 ? '�?<span style="color:var(--danger)">Consume near-expiry batches first</span> to avoid waste<br>' : '') +
        '�?Suggested purchase qty: <strong>' + suggestedQty + ' ' + unit + '</strong> (2-week safety stock)<br>' +
        (simWithoutNew.stockoutWeek !== null && simWithoutNew.stockoutWeek > 4 ?
          '�?Suggest delaying purchase by <strong>' + (simWithoutNew.stockoutWeek - 4) + ' weeks</strong><br>' : '') +
        '�?Current stock lasts <strong>' + weeksToUseOld + ' weeks</strong>' +
      '</div>' +
    '</div>';
  } else if (newBatchPosition > 1 && hasOldBatchRisk) {
    resultType = 'warn';
    html = '<div class="verify-result warn">' +
      '<h4>⚠️ Suggestion: Consume older batches first, delay purchase</h4>' +
      '<div class="detail">' +
        'FIFO priority: <strong>#' + newBatchPosition + '</strong>, need to consume ' + (newBatchPosition-1) + ' older batches first.<br><br>' +
        '<strong>Older Batch Risks:</strong><br>' +
        oldBatchesNearExpiry.map(function(b) {
          var r = assessBatchRisk(b);
          return '�?Batch "' + b.batchNo + '": ' + b.currentStock + ' ' + unit + ', ' + r.remaining + 'd left, ' +
            (r.canFinish ? 'Expected to finish normally' : '<strong style="color:var(--danger)">Will expire, scrap ¥' + (b.currentStock * (b.price||0)).toFixed(2) + '</strong>');
        }).join('<br>') +
        '<br><br>' +
        '<strong>[!] Recommendations:</strong><br>' +
        '�?Prioritize near-expiry batches<br>' +
        '�?Suggest delaying purchase by <strong>' + (simWithoutNew.stockoutWeek !== null ? Math.max(1, simWithoutNew.stockoutWeek - 3) : 4) + ' weeks</strong><br>' +
        '�?Current stock lasts <strong>' + (simWithoutNew.stockoutWeek !== null ? simWithoutNew.stockoutWeek + ' weeks' : '>2 years') + '</strong>' +
      '</div>' +
    '</div>';
  } else if (sim.stockoutWeek !== null && sim.stockoutWeek < 4) {
    resultType = 'pass';
    html = '<div class="verify-result pass">' +
      '<h4>[✓] Purchase Approved</h4>' +
      '<div class="detail">' +
        'Proposed purchase: <strong>' + qty + ' ' + unit + '</strong>, new batch expiry: <strong>' + formatDate(newBatchExpiry) + '</strong>.<br>' +
        'FIFO priority: <strong>#' + newBatchPosition + '</strong><br>' +
        'At <strong>' + weeklyUsage.toFixed(1) + ' ' + unit + '/wk</strong>, current stock only lasts <strong>' + simWithoutNew.stockoutWeek + ' weeks</strong>.<br>' +
        'No additional scrap expected, overall risk controlled.' +
      '</div>' +
    '</div>';
  } else {
    resultType = 'pass';
    html = '<div class="verify-result pass">' +
      '<h4>[✓] Purchase Approved</h4>' +
      '<div class="detail">' +
        'Proposed purchase: <strong>' + qty + ' ' + unit + '</strong>, new batch expiry: <strong>' + formatDate(newBatchExpiry) + '</strong>.<br>' +
        'FIFO priority: <strong>#' + newBatchPosition + '</strong><br>' +
        'At <strong>' + weeklyUsage.toFixed(1) + ' ' + unit + '/wk</strong>, purchase can be reasonably consumed before expiry.<br>' +
        'Projected scrap: <strong>¥' + sim.totalScrappedValue.toFixed(2) + '</strong>' +
        (sim.totalScrappedValue > 0 ? ' (monitor near-expiry batches)' : ' (no scrap risk)') +
      '</div>' +
    '</div>';
  }

  if (sim.events.length > 0) {
    html += '<div class="sim-timeline">' +
      '<h5>[=] Post-Purchase Consumption Timeline</h5>' +
      sim.events.slice(0, 10).map(function(ev) {
        var typeBadge = '';
        if (ev.type === 'scrap') typeBadge = '<span class="badge badge-danger">Scrap</span>';
        if (ev.type === 'deplete') typeBadge = '<span class="badge badge-info">Depleted</span>';
        if (ev.type === 'stockout') typeBadge = '<span class="badge badge-warning">Stockout</span>';
        return '<div class="sim-event">' +
          '<span class="sim-date">' + formatDate(ev.date) + '</span>' +
          '<span class="sim-type">' + typeBadge + '</span>' +
          '<span class="sim-desc">' + ev.desc + '</span>' +
        '</div>';
      }).join('') +
      (sim.events.length > 10 ? '<div style="padding:8px 0;font-size:11px;color:var(--gray-400)">...and ' + (sim.events.length-10) + ' more events</div>' : '') +
    '</div>';
  }

  var newBatchPrice = parseFloat(document.getElementById('verifyPrice').value) || 0;
  lastSimulationSnapshot = {
    materialName: name,
    qty: qty,
    newBatchExpiry: newBatchExpiry,
    newBatchPrice: newBatchPrice,
    weeklyUsage: weeklyUsage,
    resultType: resultType,
    recommendationText: recommendationText || '',
    suggestedPurchaseDate: null,
    suggestedQty: qty || 0,
    coverageWeeks: null,
    actionNote: '',
    oldBatchesToHandle: [],
    simWithNew: {
      totalScrappedValue: sim.totalScrappedValue,
      totalScrappedQty: sim.totalScrappedQty,
      stockoutWeek: sim.stockoutWeek,
      stockoutDate: sim.stockoutDate
    },
    simWithoutNew: {
      totalScrappedValue: simWithoutNew.totalScrappedValue,
      totalScrappedQty: simWithoutNew.totalScrappedQty,
      stockoutWeek: simWithoutNew.stockoutWeek,
      stockoutDate: simWithoutNew.stockoutDate
    }
  };

  if (weeklyUsage > 0) {
    var suggestedPurchaseDate, suggestedQty, coverageWeeks, actionNote;
    var totalExisting = fifo.reduce(function(s, b) { return s + b.currentStock; }, 0);

    if (simWithoutNew.stockoutWeek !== null) {
      var safetyWeeks = 2;
      var purchaseLeadWeeks = Math.max(0, simWithoutNew.stockoutWeek - safetyWeeks);
      suggestedPurchaseDate = addDays(today(), purchaseLeadWeeks * 7);
      suggestedQty = Math.ceil(weeklyUsage * 4);
      coverageWeeks = simWithoutNew.stockoutWeek + (suggestedQty / weeklyUsage);
    } else {
      suggestedPurchaseDate = 'No urgent need';
      suggestedQty = 0;
      coverageWeeks = '>2 years';
    }

    var oldBatchesToUse = fifo.filter(function(b) {
      return daysBetween(today(), b.expiryDate) <= 90 && b.currentStock > 0;
    }).map(function(b) {
      var r = assessBatchRisk(b);
      return {
        batchNo: b.batchNo,
        stock: b.currentStock,
        unit: unit,
        remaining: r.remaining,
        risk: r.level,
        canFinish: r.canFinish
      };
    });

    if (scrapDiff > 0) {
      actionNote = 'Reduce purchase or delay purchase - near-expiry batches need to be consumed first';
      suggestedQty = Math.max(0, Math.floor(weeklyUsage * Math.max(0, 2 - simWithoutNew.stockoutWeek)));
    } else if (hasOldBatchRisk) {
      actionNote = 'Prioritize older batch consumption, consider delaying purchase';
    } else if (sim.stockoutWeek !== null && sim.stockoutWeek < 4) {
      actionNote = 'Stock is tight, recommended to purchase soon';
    } else {
      actionNote = 'Normal procurement';
    }

    html += '<div class="purchase-plan">' +
      '<h5>[+] Purchase Plan Draft</h5>' +
      '<div class="plan-grid">' +
        '<div class="plan-item">' +
          '<div class="plan-label">Suggested Purchase Date</div>' +
          '<div class="plan-value">' + (typeof suggestedPurchaseDate === 'string' ? suggestedPurchaseDate : formatDate(suggestedPurchaseDate)) + '</div>' +
        '</div>' +
        '<div class="plan-item">' +
          '<div class="plan-label">Suggested Qty</div>' +
          '<div class="plan-value">' + suggestedQty + ' ' + unit + '</div>' +
        '</div>' +
        '<div class="plan-item">' +
          '<div class="plan-label">Est. Coverage</div>' +
          '<div class="plan-value">' + (typeof coverageWeeks === 'string' ? coverageWeeks : coverageWeeks.toFixed(1) + ' weeks') + '</div>' +
        '</div>' +
        '<div class="plan-item">' +
          '<div class="plan-label">Action Note</div>' +
          '<div class="plan-value" style="font-size:12px">' + actionNote + '</div>' +
        '</div>' +
      '</div>';

    if (oldBatchesToUse.length > 0) {
      html += '<div class="plan-old-batches">' +
        '<div class="plan-label" style="margin-bottom:8px">Older Batches to Handle First</div>' +
        oldBatchesToUse.map(function(b) {
          var badgeColor = b.risk === 'high' ? 'danger' : (b.risk === 'medium' ? 'warning' : 'info');
          var finishText = b.canFinish ? 'expected to finish' : '<span style="color:var(--danger)">WILL EXPIRE</span>';
          return '<div class="old-batch-item">' +
            '<span class="badge badge-' + badgeColor + '">' + b.batchNo + '</span> ' +
            '<span style="color:var(--gray-500)">' + b.stock + ' ' + b.unit + ', ' + b.remaining + 'd left, ' + finishText + '</span>' +
          '</div>';
        }).join('') +
      '</div>';
    }

    html += '<div style="margin-top:12px;display:flex;gap:8px">' +
      '<button class="btn btn-primary" onclick="saveCurrentPurchasePlan()">[+] Save to Meeting Agenda</button>' +
    '</div>';

    html += '</div>';

    lastSimulationSnapshot.suggestedPurchaseDate = typeof suggestedPurchaseDate === 'string' ? suggestedPurchaseDate : formatDate(suggestedPurchaseDate);
    lastSimulationSnapshot.suggestedQty = suggestedQty;
    lastSimulationSnapshot.coverageWeeks = typeof coverageWeeks === 'string' ? coverageWeeks : (coverageWeeks.toFixed(1) + ' weeks');
    lastSimulationSnapshot.actionNote = actionNote;
    lastSimulationSnapshot.oldBatchesToHandle = oldBatchesToUse;
  }

  var newBatchPrice = parseFloat(document.getElementById('verifyPrice').value) || 0;
  lastSimulationSnapshot.materialName = name;
  lastSimulationSnapshot.qty = qty;
  lastSimulationSnapshot.newBatchExpiry = newBatchExpiry;
  lastSimulationSnapshot.newBatchPrice = newBatchPrice;
  lastSimulationSnapshot.weeklyUsage = weeklyUsage;
  lastSimulationSnapshot.resultType = resultType;
  lastSimulationSnapshot.recommendationText = recommendationText || '';
  lastSimulationSnapshot.simWithNew = {
    totalScrappedValue: sim.totalScrappedValue,
    totalScrappedQty: sim.totalScrappedQty,
    stockoutWeek: sim.stockoutWeek,
    stockoutDate: sim.stockoutDate
  };
  lastSimulationSnapshot.simWithoutNew = {
    totalScrappedValue: simWithoutNew.totalScrappedValue,
    totalScrappedQty: simWithoutNew.totalScrappedQty,
    stockoutWeek: simWithoutNew.stockoutWeek,
    stockoutDate: simWithoutNew.stockoutDate
  };

  document.getElementById('verifyResult').innerHTML = html;
}

function renderDataPage() {
  var materials = loadData(STORAGE_KEY_MATERIALS);
  var usages = loadData(STORAGE_KEY_USAGES);

  document.getElementById('materialTableBody').innerHTML = materials.length === 0
    ? '<tr><td colspan="9" style="text-align:center;padding:40px;color:var(--gray-400)">No material data</td></tr>'
    : materials.slice().sort(function(a,b){
        if (a.name !== b.name) return a.name.localeCompare(b.name);
        return new Date(a.expiryDate) - new Date(b.expiryDate);
      }).map(function(m) {
      var remaining = daysBetween(today(), m.expiryDate);
      var remainingColor = remaining <= 30 ? 'var(--danger)' : (remaining <= 90 ? 'var(--warning)' : 'inherit');
      return '<tr>' +
        '<td>' + m.name + '</td><td>' + m.category + '</td><td>' + m.batchNo + '</td>' +
        '<td>' + m.currentStock + ' ' + m.unit + '</td><td>' + m.unit + '</td>' +
        '<td>' + formatDate(m.expiryDate) + '</td>' +
        '<td style="color:' + remainingColor + '">' + remaining + 'd</td>' +
        '<td>&yen;' + (m.price||0).toFixed(2) + '</td>' +
        '<td>' +
          '<button class="btn btn-outline btn-sm" onclick="editMaterial(\'' + m.id + '\')">Edit</button> ' +
          '<button class="btn btn-danger btn-sm" onclick="deleteMaterial(\'' + m.id + '\')">Delete</button>' +
        '</td>' +
      '</tr>';
    }).join('');

  document.getElementById('usageTableBody').innerHTML = usages.length === 0
    ? '<tr><td colspan="8" style="text-align:center;padding:40px;color:var(--gray-400)">No usage records</td></tr>'
    : usages.sort(function(a,b){return new Date(b.date)-new Date(a.date)}).slice(0,100).map(function(u) {
      return '<tr>' +
        '<td>' + formatDate(u.date) + '</td><td>' + u.materialName + '</td>' +
        '<td>' + (u.batchNo || '-') + '</td><td>' + u.quantity + '</td>' +
        '<td>' + u.doctor + '</td><td>' + u.department + '</td><td>' + u.treatment + '</td>' +
        '<td><button class="btn btn-danger btn-sm" onclick="deleteUsage(\'' + u.id + '\')">Delete</button></td>' +
      '</tr>';
    }).join('');
}

function openModal(id) { document.getElementById(id).classList.add('show'); }
function closeModal(id) { document.getElementById(id).classList.remove('show'); }

function openAddMaterial() {
  editingMaterialId = null;
  document.getElementById('materialModalTitle').textContent = 'Add Material';
  document.getElementById('matName').value = '';
  document.getElementById('matCategory').value = 'Restorative';
  document.getElementById('matBatch').value = '';
  document.getElementById('matStock').value = '';
  document.getElementById('matUnit').value = 'pcs';
  document.getElementById('matExpiry').value = '';
  document.getElementById('matPrice').value = '';
  openModal('materialModal');
}

function editMaterial(id) {
  var materials = loadData(STORAGE_KEY_MATERIALS);
  var m = materials.find(function(x) { return x.id === id; });
  if (!m) return;
  editingMaterialId = id;
  document.getElementById('materialModalTitle').textContent = 'Edit Material';
  document.getElementById('matName').value = m.name;
  document.getElementById('matCategory').value = m.category;
  document.getElementById('matBatch').value = m.batchNo;
  document.getElementById('matStock').value = m.currentStock;
  document.getElementById('matUnit').value = m.unit;
  document.getElementById('matExpiry').value = m.expiryDate;
  document.getElementById('matPrice').value = m.price || '';
  openModal('materialModal');
}

function saveMaterial() {
  var name = document.getElementById('matName').value.trim();
  var category = document.getElementById('matCategory').value;
  var batchNo = document.getElementById('matBatch').value.trim();
  var stock = parseFloat(document.getElementById('matStock').value) || 0;
  var unit = document.getElementById('matUnit').value;
  var expiryDate = document.getElementById('matExpiry').value;
  var price = parseFloat(document.getElementById('matPrice').value) || 0;

  if (!name || !batchNo || !expiryDate) { showToast('Please fill in required fields', 'error'); return; }

  var materials = loadData(STORAGE_KEY_MATERIALS);
  if (editingMaterialId) {
    var idx = materials.findIndex(function(m) { return m.id === editingMaterialId; });
    if (idx >= 0) {
      var oldName = materials[idx].name;
      materials[idx] = Object.assign({}, materials[idx], { name: name, category: category, batchNo: batchNo, currentStock: stock, unit: unit, expiryDate: expiryDate, price: price });
      if (oldName !== name) {
        var usages = loadData(STORAGE_KEY_USAGES);
        usages.filter(function(u) { return u.materialName === oldName; }).forEach(function(u) { u.materialName = name; });
        saveData(STORAGE_KEY_USAGES, usages);
      }
    }
  } else {
    materials.push({ id: genId(), name: name, category: category, batchNo: batchNo, currentStock: stock, unit: unit, expiryDate: expiryDate, price: price });
  }

  saveData(STORAGE_KEY_MATERIALS, materials);
  closeModal('materialModal');
  showToast(editingMaterialId ? 'Material updated' : 'Material added', 'success');
  refreshAll();
}

function deleteMaterial(id) {
  if (!confirm('Delete this material batch?')) return;
  var materials = loadData(STORAGE_KEY_MATERIALS).filter(function(m) { return m.id !== id; });
  saveData(STORAGE_KEY_MATERIALS, materials);
  refreshAll();
}

function openAddUsage() {
  var materials = loadData(STORAGE_KEY_MATERIALS);
  document.getElementById('usageDate').value = today();

  var fifoOptions = [];
  var materialSet = {};
  materials.forEach(function(m) {
    if (!materialSet[m.name]) materialSet[m.name] = [];
    materialSet[m.name].push(m);
  });

  Object.keys(materialSet).forEach(function(name) {
    var fifo = materialSet[name].sort(function(a,b){
      return new Date(a.expiryDate) - new Date(b.expiryDate);
    }).filter(function(b){ return b.currentStock > 0; });
    fifo.forEach(function(b, idx) {
      var remaining = daysBetween(today(), b.expiryDate);
      var tag = idx === 0 ? ' [FIFO #1]' : ' [#' + (idx+1) + ']';
      var warn = remaining <= 30 ? ' [!]' : (remaining <= 90 ? ' [~]' : '');
      fifoOptions.push({
        value: b.id,
        text: name + ' | ' + b.batchNo + ' | Stock:' + b.currentStock + b.unit + ' | Exp:' + formatDate(b.expiryDate) + tag + warn
      });
    });
  });

  var sel = document.getElementById('usageMaterial');
  sel.innerHTML = fifoOptions.map(function(o) {
    return '<option value="' + o.value + '">' + o.text + '</option>';
  }).join('');

  document.getElementById('usageQty').value = '';
  document.getElementById('usageDoctor').value = 'Zhang Weiming';
  document.getElementById('usageDept').value = 'General';
  document.getElementById('usageTreatment').value = 'Fissure Sealant';
  openModal('usageModal');
}

function saveUsage() {
  var date = document.getElementById('usageDate').value;
  var materialId = document.getElementById('usageMaterial').value;
  var quantity = parseFloat(document.getElementById('usageQty').value) || 0;
  var doctor = document.getElementById('usageDoctor').value;
  var department = document.getElementById('usageDept').value;
  var treatment = document.getElementById('usageTreatment').value;

  if (!date || !materialId || quantity <= 0) { showToast('Please fill in required fields', 'error'); return; }

  var materials = loadData(STORAGE_KEY_MATERIALS);
  var m = materials.find(function(x) { return x.id === materialId; });
  if (!m) { showToast('Batch not found', 'error'); return; }
  if (m.currentStock < quantity) {
    showToast('Insufficient stock, remaining ' + m.currentStock + ' ' + m.unit, 'error'); return;
  }

  var usages = loadData(STORAGE_KEY_USAGES);
  usages.push({
    id: genId(),
    date: date,
    materialId: materialId,
    materialName: m.name,
    batchNo: m.batchNo,
    quantity: quantity,
    doctor: doctor,
    department: department,
    treatment: treatment
  });
  saveData(STORAGE_KEY_USAGES, usages);

  m.currentStock = Math.max(0, m.currentStock - quantity);
  saveData(STORAGE_KEY_MATERIALS, materials);

  closeModal('usageModal');
  showToast('Usage recorded, batch ' + m.batchNo + ' deducted ' + quantity + ' ' + m.unit, 'success');
  refreshAll();
}

function deleteUsage(id) {
  if (!confirm('Delete this usage record? (Stock will NOT be auto-restored)')) return;
  var usages = loadData(STORAGE_KEY_USAGES).filter(function(u) { return u.id !== id; });
  saveData(STORAGE_KEY_USAGES, usages);
  refreshAll();
}

function importCSV() {
  csvImportType = 'material';
  document.getElementById('csvModalTitle').textContent = 'Import Material Stock CSV';
  document.getElementById('csvHelpText').textContent = 'CSV Format: Name,Category,BatchNo,Stock,Unit,ExpiryDate,Price\nExample: Fissure Sealant,Preventive,BN20250601,25,pcs,2026-03-15,68.50';
  document.getElementById('csvInput').value = '';
  openModal('csvModal');
}

function importUsageCSV() {
  csvImportType = 'usage';
  document.getElementById('csvModalTitle').textContent = 'Import Usage Records CSV';
  document.getElementById('csvHelpText').textContent = 'CSV Format: Date,MaterialName,BatchNo(optional),Quantity,Doctor,Department,Treatment\nExample: 2026-06-10,Fissure Sealant,BN20250601,3,Zhang Weiiming,Pediatric,Fissure Sealant';
  document.getElementById('csvInput').value = '';
  openModal('csvModal');
}

function doCSVImport() {
  var raw = document.getElementById('csvInput').value.trim();
  if (!raw) { showToast('Please paste CSV content', 'error'); return; }

  var lines = raw.split('\n').map(function(l) { return l.trim(); }).filter(function(l) {
    return l && l.indexOf('Name') !== 0 && l.indexOf('Date') !== 0 && l.indexOf('材料名称') !== 0 && l.indexOf('日期') !== 0;
  });

  if (csvImportType === 'material') {
    var materials = loadData(STORAGE_KEY_MATERIALS);
    var count = 0;
    lines.forEach(function(line) {
      var parts = line.split(',').map(function(s) { return s.trim(); });
      if (parts.length >= 6) {
        materials.push({
          id: genId(),
          name: parts[0],
          category: parts[1],
          batchNo: parts[2],
          currentStock: parseFloat(parts[3]) || 0,
          unit: parts[4] || 'pcs',
          expiryDate: parts[5],
          price: parseFloat(parts[6]) || 0
        });
        count++;
      }
    });
    saveData(STORAGE_KEY_MATERIALS, materials);
    showToast('Successfully imported ' + count + ' material records', 'success');
  } else {
    var usages = loadData(STORAGE_KEY_USAGES);
    var allMaterials = loadData(STORAGE_KEY_MATERIALS);
    var count2 = 0;
    var missBatch = 0;
    lines.forEach(function(line) {
      var parts = line.split(',').map(function(s) { return s.trim(); });
      if (parts.length >= 6) {
        var matName = parts[1];
        var batchNo = parts[2] || '';
        var mat = null;
        if (batchNo) {
          mat = allMaterials.find(function(m) { return m.name === matName && m.batchNo === batchNo; });
        }
        if (!mat) {
          var fifo = allMaterials.filter(function(m) { return m.name === matName && m.currentStock > 0; })
            .sort(function(a,b){ return new Date(a.expiryDate) - new Date(b.expiryDate); });
          if (fifo.length > 0) {
            mat = fifo[0];
            missBatch++;
          }
        }
        if (mat) {
          usages.push({
            id: genId(),
            date: parts[0],
            materialId: mat.id,
            materialName: matName,
            batchNo: mat.batchNo,
            quantity: parseFloat(parts[3]) || 0,
            doctor: parts[4],
            department: parts[5],
            treatment: parts[6] || '其他'
          });
          count2++;
        }
      }
    });
    saveData(STORAGE_KEY_USAGES, usages);
    showToast('Successfully imported ' + count2 + ' usage records' + (missBatch > 0 ? ' (' + missBatch + ' auto-matched by FIFO)' : ''), 'success');
  }

  closeModal('csvModal');
  refreshAll();
}

function exportData() {
  var materials = loadData(STORAGE_KEY_MATERIALS);
  var usages = loadData(STORAGE_KEY_USAGES);
  var data = { materials: materials, usages: usages, exportDate: today() };
  var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '齿科智采_数据导出_' + today() + '.json';
  a.click();
  showToast('Data exported', 'success');
}

function resetData() {
  if (!confirm('Reset all data? This will regenerate sample data.')) return;
  localStorage.removeItem(STORAGE_KEY_MATERIALS);
  localStorage.removeItem(STORAGE_KEY_USAGES);
  initSampleData();
  refreshAll();
  showToast('Data reset', 'success');
}

function showToast(msg, type) {
  var existing = document.querySelector('.toast');
  if (existing) existing.remove();
  var div = document.createElement('div');
  div.className = 'toast ' + type;
  div.textContent = msg;
  document.body.appendChild(div);
  setTimeout(function() { div.remove(); }, 3500);
}

function saveCurrentPurchasePlan() {
  if (!lastSimulationSnapshot) { showToast('Please run simulation first', 'warn'); return; }
  var s = lastSimulationSnapshot;
  var plan = {
    id: genId(),
    createdAt: new Date().toISOString(),
    materialName: s.materialName,
    verifyInput: {
      qty: s.qty,
      newBatchExpiry: s.newBatchExpiry,
      newBatchPrice: s.newBatchPrice
    },
    suggestedPurchaseDate: s.suggestedPurchaseDate,
    suggestedQty: s.suggestedQty,
    coverageWeeks: s.coverageWeeks,
    actionNote: s.actionNote,
    oldBatchesToHandle: s.oldBatchesToHandle,
    resultType: s.resultType,
    recommendationText: s.recommendationText,
    simulation: {
      simWithNew: {
        totalScrappedValue: s.simWithNew.totalScrappedValue,
        totalScrappedQty: s.simWithNew.totalScrappedQty,
        stockoutWeek: s.simWithNew.stockoutWeek,
        stockoutDate: s.simWithNew.stockoutDate
      },
      simWithoutNew: {
        totalScrappedValue: s.simWithoutNew.totalScrappedValue,
        totalScrappedQty: s.simWithoutNew.totalScrappedQty,
        stockoutWeek: s.simWithoutNew.stockoutWeek,
        stockoutDate: s.simWithoutNew.stockoutDate
      }
    },
    status: 'pending',
    discussionNote: '',
    finalQty: null
  };
  var plans = loadData(STORAGE_KEY_PLANS);
  plans.unshift(plan);
  saveData(STORAGE_KEY_PLANS, plans);
  showToast('Saved to Weekly Meeting agenda', 'success');
  renderPurchasePlansInVerify(plan.id);
}

function getLatestPlanByMaterial() {
  var plans = loadData(STORAGE_KEY_PLANS);
  var map = {};
  plans.forEach(function(p) {
    if (!map[p.materialName]) map[p.materialName] = p;
  });
  return map;
}

function updatePlanStatus(planId, status, finalQty, note) {
  var plans = loadData(STORAGE_KEY_PLANS);
  var idx = plans.findIndex(function(p) { return p.id === planId; });
  if (idx < 0) return;
  plans[idx].status = status;
  plans[idx].discussionNote = note || plans[idx].discussionNote;
  if (typeof finalQty === 'number' && !isNaN(finalQty)) plans[idx].finalQty = finalQty;
  plans[idx].updatedAt = new Date().toISOString();
  saveData(STORAGE_KEY_PLANS, plans);
  showToast('Plan status updated: ' + status, 'success');
  refreshAll();
}

function openPlanQuickModal(planId) {
  var plans = loadData(STORAGE_KEY_PLANS);
  var plan = plans.find(function(p) { return p.id === planId; });
  if (!plan) return;
  var html = '<div id="planQuickModal" class="modal-overlay" onclick="if(event.target===this)this.remove()">' +
    '<div class="modal modal-sm">' +
      '<div class="modal-header">' +
        '<h3>Plan Status - ' + plan.materialName + '</h3>' +
        '<button class="close-btn" onclick="document.getElementById(\'planQuickModal\').remove()">x</button>' +
      '</div>' +
      '<div class="modal-body">' +
        '<div style="margin-bottom:12px;padding:10px;background:var(--gray-50);border-radius:6px;font-size:12px">' +
          '<div><strong>Created:</strong> ' + plan.createdAt.substr(0, 16).replace('T', ' ') + '</div>' +
          '<div><strong>Suggested:</strong> ' + plan.suggestedQty + ' pcs, buy ' + (typeof plan.suggestedPurchaseDate === 'string' ? plan.suggestedPurchaseDate : formatDate(plan.suggestedPurchaseDate)) + '</div>' +
          '<div><strong>Note:</strong> ' + plan.actionNote + '</div>' +
        '</div>' +
        '<div class="form-group"><label>Final Qty</label>' +
          '<input id="planFinalQty" type="number" value="' + (plan.finalQty !== null ? plan.finalQty : plan.suggestedQty) + '">' +
        '</div>' +
        '<div class="form-group"><label>Discussion Note</label>' +
          '<textarea id="planNote" rows="2">' + (plan.discussionNote || '') + '</textarea>' +
        '</div>' +
        '<div style="display:flex;gap:8px">' +
          '<button class="btn btn-success" onclick="quickUpdatePlan(\'' + planId + '\',\'approved\')">Approve</button>' +
          '<button class="btn btn-outline" onclick="quickUpdatePlan(\'' + planId + '\',\'delayed\')">Delay</button>' +
          '<button class="btn btn-warning" onclick="quickUpdatePlan(\'' + planId + '\',\'modified\')">Modify</button>' +
          '<button class="btn btn-outline" onclick="quickUpdatePlan(\'' + planId + '\',\'cancelled\')">Cancel</button>' +
        '</div>' +
      '</div>' +
    '</div></div>';
  var div = document.createElement('div');
  div.innerHTML = html;
  document.body.appendChild(div.firstElementChild);
}

function quickUpdatePlan(planId, status) {
  var qty = parseFloat(document.getElementById('planFinalQty').value);
  var note = document.getElementById('planNote').value;
  updatePlanStatus(planId, status, isNaN(qty) ? null : qty, note);
  var m = document.getElementById('planQuickModal');
  if (m) m.remove();
}

function renderPurchasePlansInVerify(highlightId) {
  var plans = loadData(STORAGE_KEY_PLANS).slice(0, 5);
  var container = document.getElementById('verifyPlansList');
  if (!container) return;
  if (plans.length === 0) { container.innerHTML = ''; return; }
  var statusColors = { pending: 'warning', approved: 'success', delayed: 'info', modified: 'primary', cancelled: 'danger' };
  var statusLabels = { pending: 'Pending', approved: 'Approved', delayed: 'Delayed', modified: 'Modified', cancelled: 'Cancelled' };
  container.innerHTML = '<h5 style="font-size:13px;margin:16px 0 8px;font-weight:600;color:var(--gray-700)">[=] Recent Purchase Plans</h5>' +
    plans.map(function(p) {
      var color = statusColors[p.status] || 'gray';
      var label = statusLabels[p.status] || p.status;
      var hl = highlightId === p.id ? 'style="border:2px solid var(--primary);background:#eef2ff"' : '';
      return '<div class="plan-item-row" ' + hl + ' onclick="openPlanQuickModal(\'' + p.id + '\')" style="cursor:pointer;padding:8px 10px;border:1px solid var(--gray-200);border-radius:6px;margin-bottom:6px">' +
        '<div style="display:flex;justify-content:space-between;align-items:center">' +
          '<span style="font-weight:600;font-size:12px">' + p.materialName + '</span>' +
          '<span class="badge badge-' + color + '">' + label + '</span>' +
        '</div>' +
        '<div style="font-size:11px;color:var(--gray-500);margin-top:2px">' +
          p.suggestedQty + ' pcs | created ' + p.createdAt.substr(5, 11).replace('T', ' ') +
          (p.finalQty !== null ? ' | final: ' + p.finalQty : '') +
        '</div>' +
      '</div>';
    }).join('');
}

function refreshAll() {
  renderCategoryFilter();
  var activePage = document.querySelector('.page.active');
  if (activePage) {
    if (activePage.id === 'page-dashboard') renderDashboard();
    else if (activePage.id === 'page-verify') { renderVerify(); renderPurchasePlansInVerify(); }
    else if (activePage.id === 'page-data') renderDataPage();
  }
}

function initSampleData() {
  if (loadData(STORAGE_KEY_MATERIALS).length > 0) return;

  var now = new Date();
  var materials = [
    { id: genId(), name: 'Fissure Sealant', category: 'Preventive', batchNo: 'BN20250601', currentStock: 35, unit: 'pcs', expiryDate: formatDate(new Date(now.getTime() + 25*86400000)), price: 68.50 },
    { id: genId(), name: 'Fissure Sealant', category: 'Preventive', batchNo: 'BN20251201', currentStock: 50, unit: 'pcs', expiryDate: formatDate(new Date(now.getTime() + 180*86400000)), price: 68.50 },
    { id: genId(), name: 'Silicone Impression', category: 'Impression', batchNo: 'YM20250401', currentStock: 20, unit: 'sets', expiryDate: formatDate(new Date(now.getTime() + 55*86400000)), price: 125.00 },
    { id: genId(), name: 'Silicone Impression', category: 'Impression', batchNo: 'YM20251001', currentStock: 25, unit: 'sets', expiryDate: formatDate(new Date(now.getTime() + 150*86400000)), price: 125.00 },
    { id: genId(), name: 'Silicone Impression', category: 'Impression', batchNo: 'YM20260101', currentStock: 30, unit: 'sets', expiryDate: formatDate(new Date(now.getTime() + 280*86400000)), price: 128.00 },
    { id: genId(), name: 'Light Cure Resin (A2)', category: 'Restorative', batchNo: 'SG20250701', currentStock: 18, unit: 'pcs', expiryDate: formatDate(new Date(now.getTime() + 120*86400000)), price: 89.00 },
    { id: genId(), name: 'Root Canal Sealer', category: 'Endodontic', batchNo: 'GG20250301', currentStock: 12, unit: 'pcs', expiryDate: formatDate(new Date(now.getTime() + 15*86400000)), price: 56.00 },
    { id: genId(), name: 'Root Canal Sealer', category: 'Endodontic', batchNo: 'GG20250901', currentStock: 28, unit: 'pcs', expiryDate: formatDate(new Date(now.getTime() + 110*86400000)), price: 56.00 },
    { id: genId(), name: 'Glass Ionomer Cement', category: 'Adhesive', batchNo: 'BL20250801', currentStock: 12, unit: 'btls', expiryDate: formatDate(new Date(now.getTime() + 180*86400000)), price: 72.00 },
    { id: genId(), name: 'Alginate Impression', category: 'Impression', batchNo: 'ZS20250501', currentStock: 40, unit: 'pkts', expiryDate: formatDate(new Date(now.getTime() + 40*86400000)), price: 28.00 },
    { id: genId(), name: 'Gutta Percha Points', category: 'Endodontic', batchNo: 'YJ20250601', currentStock: 60, unit: 'boxes', expiryDate: formatDate(new Date(now.getTime() + 75*86400000)), price: 35.00 },
    { id: genId(), name: 'Self-Etching Bond', category: 'Adhesive', batchNo: 'ZS20250401', currentStock: 8, unit: 'btls', expiryDate: formatDate(new Date(now.getTime() + 65*86400000)), price: 108.00 },
    { id: genId(), name: 'Self-Etching Bond', category: 'Adhesive', batchNo: 'ZS20251101', currentStock: 15, unit: 'btls', expiryDate: formatDate(new Date(now.getTime() + 200*86400000)), price: 108.00 }
  ];
  saveData(STORAGE_KEY_MATERIALS, materials);

  var doctors = ['Zhang Weiming','Li Fang','Wang Jianguo','Chen Jing','Liu Yang'];
  var depts = ['General','Orthodontics','Prosthodontics','Pediatric','Periodontics','Surgery'];
  var treatments = ['Fissure Sealant','Resin Filling','Root Canal','Fixed Prosthesis','Removable Prosthesis','Orthodontic Bonding','Extraction','Scaling','Implant','Other'];

  var matBatchMap = {};
  materials.forEach(function(m) {
    if (!matBatchMap[m.name]) matBatchMap[m.name] = [];
    matBatchMap[m.name].push(m);
  });

  var usages = [];
  for (var d = 55; d >= 0; d--) {
    var numEntries = Math.floor(Math.random() * 3) + 1;
    for (var e = 0; e < numEntries; e++) {
      var matNames = Object.keys(matBatchMap);
      var matName = matNames[Math.floor(Math.random() * matNames.length)];
      var batches = matBatchMap[matName].filter(function(b) {
        return new Date(b.expiryDate) > new Date(now.getTime() - d * 86400000);
      }).sort(function(a,b){ return new Date(a.expiryDate) - new Date(b.expiryDate); });
      if (batches.length === 0) continue;

      var useFifo = Math.random() < 0.85;
      var batch = useFifo ? batches[0] : batches[Math.floor(Math.random() * batches.length)];
      var doctor = doctors[Math.floor(Math.random() * doctors.length)];
      var dept = depts[Math.floor(Math.random() * depts.length)];
      var treatment = treatments[Math.floor(Math.random() * treatments.length)];
      var qty = Math.floor(Math.random() * 4) + 1;
      var dateObj = new Date(now.getTime() - d * 86400000);
      usages.push({
        id: genId(),
        date: formatDate(dateObj),
        materialId: batch.id,
        materialName: matName,
        batchNo: batch.batchNo,
        quantity: qty,
        doctor: doctor,
        department: dept,
        treatment: treatment
      });
    }
  }
  saveData(STORAGE_KEY_USAGES, usages);
}

initSampleData();
renderCategoryFilter();
renderDashboard();

