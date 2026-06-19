
var STORAGE_KEY_MATERIALS = 'dental_materials_v2';
var STORAGE_KEY_USAGES = 'dental_usages_v2';
var editingMaterialId = null;
var chartInstances = {};
var csvImportType = 'material';
var dashboardView = 'risk';

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

function assessBatchRisk(material) {
  var remaining = daysBetween(today(), material.expiryDate);
  var weeklyAvg = getWeeklyAvg(material.name);
  var weeksToDeplete = weeklyAvg > 0 ? material.currentStock / weeklyAvg : Infinity;
  var weeksToExpiry = remaining / 7;
  var canFinish = weeksToDeplete <= weeksToExpiry;
  var level, label, suggestion;

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
    weeksToExpiry: weeksToExpiry,
    canFinish: canFinish,
    level: level,
    label: label,
    suggestion: suggestion
  };
}

function simulateConsumption(materialName, weeklyUsage, newBatchQty, newBatchExpiry) {
  var batches = getFIFOBatches(materialName);
  var unit = batches.length > 0 ? batches[0].unit : 'pcs';
  var price = batches.length > 0 ? (batches[0].price || 0) : 0;

  if (newBatchQty > 0 && newBatchExpiry) {
    batches.push({
      id: 'new',
      name: materialName,
      batchNo: 'New Batch',
      currentStock: newBatchQty,
      unit: unit,
      expiryDate: newBatchExpiry,
      price: price,
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
  var price = batches[0].price || 0;

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
          events.push({
            week: w,
            type: 'scrap',
            batchNo: batch.batchNo,
            qty: batch.remainingStock,
            value: batch.remainingStock * price,
            date: batch.expiryDate
          });
          scrapInfo.totalQty += batch.remainingStock;
          scrapInfo.totalValue += batch.remainingStock * price;
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
  document.getElementById('riskFilters').style.display = view === 'risk' ? 'flex' : 'none';
  if (view === 'prediction') renderPredictions();
}

function renderDashboard() {
  renderStats();
  renderCategoryFilter();
  renderRiskList();
  if (dashboardView === 'prediction') renderPredictions();
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

  var fifoMap = {};
  riskItems.forEach(function(m) {
    if (!fifoMap[m.name]) fifoMap[m.name] = getFIFOBatches(m.name);
  });

  var tbody = document.getElementById('riskTableBody');
  if (riskItems.length === 0) {
    tbody.innerHTML = '<tr><td colspan="12" style="text-align:center;padding:40px;color:var(--gray-400)">暂无风险材料数据，请先添加材料库�?/td></tr>';
    return;
  }

  tbody.innerHTML = riskItems.map(function(m) {
    var r = m.risk;
    var badgeClass = { high: 'badge-danger', medium: 'badge-warning', low: 'badge-success' }[r.level];
    var barPct = Math.min(100, r.weeksToExpiry > 0 ? (r.weeksToDeplete / r.weeksToExpiry) * 100 : 100);
    var barColor = r.canFinish ? 'var(--success)' : 'var(--danger)';
    var finishLabel = r.weeklyAvg === 0 ? 'No usage data' : (r.canFinish ? 'OK - Finishable' : 'RISK - Will expire');
    var remainingColor = r.remaining <= 30 ? 'var(--danger)' : (r.remaining <= 90 ? 'var(--warning)' : 'var(--gray-600)');

    var fifoList = fifoMap[m.name];
    var fifoOrder = fifoList.findIndex(function(b) { return b.id === m.id; }) + 1;
    var fifoLabel = fifoOrder > 0 ? ('#' + fifoOrder) : '-';

    return '<tr>' +
      '<td><span class="badge ' + badgeClass + '">' + r.label + '</span></td>' +
      '<td><a class="material-link" onclick="showDetail(\'' + m.id + '\')">' + m.name + '</a></td>' +
      '<td>' + m.batchNo + '</td>' +
      '<td>' + m.currentStock + ' ' + m.unit + '</td>' +
      '<td>' + formatDate(m.expiryDate) + '</td>' +
      '<td style="font-weight:600;color:' + remainingColor + '">' + r.remaining + '�?/td>' +
      '<td>' + (r.weeklyAvg > 0 ? r.weeklyAvg.toFixed(1) : '-') + '</td>' +
      '<td><div class="risk-bar"><div class="risk-bar-fill" style="width:' + Math.min(barPct, 100) + '%;background:' + barColor + '"></div></div> ' + (r.weeksToDeplete !== Infinity ? r.weeksToDeplete.toFixed(1) + 'w' : 'inf') + '</td>' +
      '<td style="font-weight:600">' + finishLabel + '</td>' +
      '<td><span class="badge ' + (fifoOrder === 1 ? 'badge-info' : 'badge-success') + '">' + fifoLabel + '</span></td>' +
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
    allBatchesHtml = '<div style="margin-top:16px"><h4 style="font-size:14px;font-weight:600;margin-bottom:10px">Other Batches (FIFO Order)</h4>' +
      '<div class="usage-table"><table><thead><tr><th>Priority</th><th>Batch No.</th><th>Stock</th><th>Expiry</th><th>Days Left</th></tr></thead><tbody>' +
      allBatches.map(function(b, idx) {
        var badge = idx + 1 === fifoOrder ? '<span class="fifo-badge">Current</span>' : '';
        var days = daysBetween(today(), b.expiryDate);
        var col = days <= 30 ? 'var(--danger)' : (days <= 90 ? 'var(--warning)' : 'inherit');
        return '<tr' + (idx + 1 === fifoOrder ? ' style="background:var(--primary-light)"' : '') + '>' +
          '<td>#' + (idx + 1) + badge + '</td>' +
          '<td>' + b.batchNo + '</td>' +
          '<td>' + b.currentStock + ' ' + b.unit + '</td>' +
          '<td>' + formatDate(b.expiryDate) + '</td>' +
          '<td style="color:' + col + '">' + days + 'd</td>' +
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

  var avg = getWeeklyAvg(name);
  document.getElementById('verifyWeeklyUsage').value = avg > 0 ? avg.toFixed(1) : '';

  var fifo = getFIFOBatches(name);
  document.getElementById('verifyStockBody').innerHTML = fifo.map(function(b, idx) {
    var remaining = daysBetween(today(), b.expiryDate);
    var weeksToDeplete = avg > 0 ? (b.currentStock / avg).toFixed(1) : 'inf';
    var remainingColor = remaining <= 30 ? 'var(--danger)' : (remaining <= 90 ? 'var(--warning)' : 'inherit');
    var priority = idx === 0 ? '<span class="badge badge-info">#1</span>' : '<span class="badge badge-success">#' + (idx+1) + '</span>';
    return '<tr>' +
      '<td>' + priority + '</td>' +
      '<td>' + b.batchNo + '</td>' +
      '<td>' + b.currentStock + ' ' + b.unit + '</td>' +
      '<td>' + formatDate(b.expiryDate) + '</td>' +
      '<td style="color:' + remainingColor + '">' + remaining + 'd</td>' +
      '<td>' + (avg > 0 ? avg.toFixed(1) : '-') + '</td>' +
      '<td>' + weeksToDeplete + 'w</td>' +
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

function refreshAll() {
  renderCategoryFilter();
  var activePage = document.querySelector('.page.active');
  if (activePage) {
    if (activePage.id === 'page-dashboard') renderDashboard();
    else if (activePage.id === 'page-verify') renderVerify();
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

