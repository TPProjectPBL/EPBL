/* Sightline · 视线热力图工作台
 * 追踪：本地 WebGazer 2.1.2（vendor/webgazer）+ 9 点手动标定
 * 记录：30Hz 注视采样 → 舞台坐标 → 核密度热力 / 轨迹 / 点阵
 * 数据只保存在浏览器内存与本机导出文件中。
 */
(() => {
  'use strict';

  const STAGE_W = 1280;
  const STAGE_H = 800;
  const HEAT_W = 640;
  const HEAT_H = 400;
  const HEAT_SCALE = HEAT_W / STAGE_W;

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const now = () => performance.now();
  const fmtTime = (ms) => {
    const total = Math.max(0, Math.floor(ms / 1000));
    const m = String(Math.floor(total / 60)).padStart(2, '0');
    const s = String(total % 60).padStart(2, '0');
    return m + ':' + s;
  };

  /* ============================================================
     刺激内容
     ============================================================ */
  const CONTENT_DEFS = {
    article: {
      title: '注意力的形状',
      label: '深度阅读',
      render: () => `
        <div class="c-article">
          <div class="a-mast" data-aoi="顶部导航">
            <div class="a-logo">MARGIN <em>观察与写作</em></div>
            <div class="a-issue"><span>第 28 期</span><span>视觉 · 认知</span><span>2026 / 11</span></div>
          </div>
          <div class="a-body">
            <div class="a-left">
              <div class="a-kicker" data-aoi="栏目标签">COVER STORY — 注意力研究</div>
              <h2 data-aoi="主标题">注意力的<em>形状</em></h2>
              <p class="a-deck" data-aoi="导语">当视线被记录，阅读就不再只是「看过」。
                每一次停留、回看与跳读，都会在页面上留下可以被看见的路径。</p>
              <div class="a-cols" data-aoi="正文段落">
                <div>
                  <p>我们总以为自己是在均匀地阅读一页文字，但眼睛从不这样做。它更像一只不安分的手，在标题、数字与图像之间快速试探，只在少数几个位置停留。</p>
                  <p>研究者把这种停留叫做注视，把两次注视之间的跳跃叫做眼跳。一段看似平顺的阅读，其实由数百次微小的落点组成。</p>
                  <p>真正决定阅读质量的，往往不是字数，而是这些落点是否被结构接住。</p>
                </div>
                <div>
                  <p>当许多人的落点叠加在一起，注意力便显现出形状：有的地方明亮而集中，有的地方几乎没有被真正看见。</p>
                  <p>热力图不是评判，而是一面镜子。它让设计者第一次看到，自己以为重要的信息，是否真的被目光接住。</p>
                  <p>所以我们把页面当作一张地形图：标题是高地，图像是磁极，正文则是需要被照亮的谷地。</p>
                </div>
              </div>
              <div class="a-quote" data-aoi="引文">
                「我们以为自己在扫描页面，其实页面也在筛选我们。」
                <span>— 视觉认知研究笔记</span>
              </div>
              <div class="a-note" data-aoi="编辑注">
                <b>编辑注</b>
                <span>样本来自本页的 5 人预测试读。颜色越暖，停留越久；它不评价内容好坏，只显示注意力落在哪里。</span>
              </div>
              <div class="a-method" data-aoi="研究方法">
                <div class="a-method-h"><b>研究方法</b><span>本页读数的来源</span></div>
                <div><b>30Hz</b><span>眼动采样</span></div>
                <div><b>9 点</b><span>标定</span></div>
                <div><b>5 点</b><span>校验</span></div>
              </div>
            </div>
            <div class="a-right">
              <div class="a-figure" data-aoi="配图">
                <svg viewBox="0 0 400 240" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <defs>
                    <radialGradient id="figGlow" cx="50%" cy="46%" r="55%">
                      <stop offset="0%" stop-color="#c2410c" stop-opacity=".34"/>
                      <stop offset="60%" stop-color="#c2410c" stop-opacity=".08"/>
                      <stop offset="100%" stop-color="#c2410c" stop-opacity="0"/>
                    </radialGradient>
                  </defs>
                  <rect width="400" height="240" fill="#e8dfcf"/>
                  <g stroke="#1c1a16" stroke-opacity=".12">
                    <path d="M0 40h400M0 80h400M0 120h400M0 160h400M0 200h400"/>
                    <path d="M40 0v240M80 0v240M120 0v240M160 0v240M200 0v240M240 0v240M280 0v240M320 0v240M360 0v240"/>
                  </g>
                  <circle cx="204" cy="112" r="86" fill="url(#figGlow)"/>
                  <path d="M92 112c26-34 60-51 108-51s84 17 110 51c-26 34-62 51-110 51s-82-17-108-51Z" stroke="#1c1a16" stroke-opacity=".52" stroke-width="1.2"/>
                  <circle cx="207" cy="112" r="30" stroke="#1c1a16" stroke-opacity=".5" stroke-width="1.2"/>
                  <circle cx="213" cy="108" r="13" fill="#9a3412" fill-opacity=".8"/>
                  <circle cx="213" cy="108" r="26" stroke="#9a3412" stroke-opacity=".4" stroke-width=".8"/>
                  <g fill="#1c1a16">
                    <circle cx="150" cy="86" r="1.6" fill-opacity=".8"/>
                    <circle cx="182" cy="70" r="1.4" fill-opacity=".6"/>
                    <circle cx="238" cy="78" r="1.8" fill-opacity=".8"/>
                    <circle cx="270" cy="96" r="1.3" fill-opacity=".5"/>
                    <circle cx="166" cy="140" r="1.5" fill-opacity=".6"/>
                    <circle cx="250" cy="142" r="1.6" fill-opacity=".7"/>
                  </g>
                  <path d="M150 86 182 70 238 78 270 96" stroke="#9a3412" stroke-opacity=".5" stroke-width=".9" stroke-dasharray="3 4"/>
                  <path d="M166 140 213 108 250 142" stroke="#9a3412" stroke-opacity=".5" stroke-width=".9" stroke-dasharray="3 4"/>
                  <g font-family="monospace" font-size="6.5" fill="#1c1a16" fill-opacity=".55">
                    <text x="20" y="226">FIG. 01 — GAZE PATH / 4.2s</text>
                    <text x="330" y="226">EYE-TRACKING</text>
                  </g>
                </svg>
              </div>
              <div class="a-cap">图 1 — 单次阅读的注视点与眼跳路径。圆点面积代表停留时长。</div>
              <div class="a-stat" data-aoi="关键数据">
                <b>68<span>%</span></b>
                <small>首屏注意力集中在标题、导语与图像三处，正文第一段仅获得 11%。</small>
              </div>
              <div class="a-quote" style="border-left-color:#1c1a16">
                一次注视通常持续 200–300 毫秒。阅读一页 800 字的文章，大约会发生 240 次这样的停顿。
                <span>— 测量方法</span>
              </div>
              <div class="a-source" data-aoi="数据来源">
                <b>数据来源</b>
                <span>5 位读者 · 412 次注视 · 平均 4.2 秒</span>
              </div>
            </div>
          </div>
          <div class="a-bottom" data-aoi="阅读要点">
            <div><b>01</b><span>平均注视 200–300ms</span><small>一次停留足够读完两三个词，然后立刻跳走。</small></div>
            <div><b>02</b><span>标题与图表最容易被回看</span><small>它们决定读者是否愿意进入正文。</small></div>
            <div><b>03</b><span>正文首段最容易被跳过</span><small>导语承担了大部分筛选与承诺。</small></div>
          </div>
          <div class="a-foot" data-aoi="页脚标签">
            <span>MARGIN · 观察与写作 / 第 28 期</span>
            <div class="a-tags"><span>注意力</span><span>眼动</span><span>信息设计</span></div>
          </div>
        </div>`,
    },

    landing: {
      title: 'Orbit — 团队工作台',
      label: '产品落地页',
      render: () => `
        <div class="c-landing">
          <div class="l-glow"></div>
          <div class="l-glow2"></div>
          <div class="l-nav" data-aoi="顶部导航">
            <div class="l-brand"><i></i>Orbit</div>
            <div class="l-links"><span>产品</span><span>方案</span><span>定价</span><span>文档</span></div>
            <div class="l-nav-right"><span>登录</span><span class="l-signup">免费开始</span></div>
          </div>
          <div class="l-hero">
            <div class="l-hero-left">
              <div class="l-eyebrow" data-aoi="信任标签">ORBIT 3.0 现已发布</div>
              <h2 data-aoi="主标题">让团队的每个<br/>决定都<span>有迹可循</span></h2>
              <p class="l-sub" data-aoi="副标题">把目标、讨论与结果放进同一个空间。Orbit 帮你看清项目真正的推进方式，而不是只看进度条。</p>
              <div class="l-cta" data-aoi="行动按钮">
                <span class="l-btn">免费试用 14 天 →</span>
                <span class="l-btn ghost">预约演示</span>
              </div>
              <div class="l-proof" data-aoi="社会证明">
                <div class="l-avatars"><i></i><i></i><i></i><i></i></div>
                <span>已有 4,200+ 团队在用 Orbit 组织工作</span>
              </div>
            </div>
            <div class="l-product" data-aoi="产品界面">
              <div class="l-window">
                <div class="l-wbar"><i></i><i></i><i></i></div>
                <div class="l-wbody">
                  <div class="l-wtop"><b>产品增长 · Q4</b><span>本周视图</span></div>
                  <div class="l-wrow">
                    <div class="l-wcard"><small>活跃项目</small><b>18<em>+3</em></b></div>
                    <div class="l-wcard"><small>按期交付</small><b>92%<em>+6%</em></b></div>
                    <div class="l-wcard"><small>决策周期</small><b>2.4d<em>-0.8</em></b></div>
                  </div>
                  <div class="l-wchart">
                    <svg viewBox="0 0 320 78" fill="none" preserveAspectRatio="none">
                      <defs>
                        <linearGradient id="lwArea" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stop-color="#3b82f6" stop-opacity=".38"/>
                          <stop offset="100%" stop-color="#3b82f6" stop-opacity="0"/>
                        </linearGradient>
                      </defs>
                      <g stroke="#2a3242" stroke-width=".6">
                        <path d="M0 20h320M0 40h320M0 60h320"/>
                      </g>
                      <path d="M0 62 32 54 64 57 96 40 128 44 160 30 192 34 224 20 256 24 288 12 320 16V78H0Z" fill="url(#lwArea)"/>
                      <path d="M0 62 32 54 64 57 96 40 128 44 160 30 192 34 224 20 256 24 288 12 320 16" stroke="#60a5fa" stroke-width="1.6"/>
                      <path d="M0 70 32 66 64 68 96 58 128 62 160 52 192 56 224 48 256 50 288 42 320 46" stroke="#64748b" stroke-width="1" stroke-dasharray="3 3"/>
                    </svg>
                  </div>
                  <div class="l-wfoot"><span>近 12 周推进趋势</span><span>更新于 2 分钟前</span></div>
                </div>
              </div>
              <div class="l-badge-float"><b>+28%</b><span>团队交付效率</span></div>
            </div>
          </div>
          <div class="l-metrics" data-aoi="信任数据">
            <div><b>99.98%</b><span>过去 12 个月可用性</span></div>
            <div><b>4.9/5</b><span>G2 用户评分</span></div>
            <div><b>12+</b><span>与现有工具集成</span></div>
            <div><b>SOC 2</b><span>Type II 合规认证</span></div>
          </div>
          <div class="l-logos" data-aoi="客户 Logo">
            <span>TRUSTED BY TEAMS AT</span>
            <b>Northwind</b><b>Linear</b><b>Vercel</b><b>Figma</b><b>Notion</b><b>Ramp</b>
          </div>
          <div class="l-features">
            <div class="l-feature" data-aoi="功能卡片">
              <div class="l-ficon">01</div>
              <h3>目标与执行同屏</h3>
              <p>从季度目标直接下钻到具体任务，不需要在三个工具之间来回切换。</p>
            </div>
            <div class="l-feature" data-aoi="功能卡片">
              <div class="l-ficon">02</div>
              <h3>决策自动留痕</h3>
              <p>每次讨论、否决与变更都被记录在上下文里，新成员也能快速补齐背景。</p>
            </div>
            <div class="l-feature" data-aoi="功能卡片">
              <div class="l-ficon">03</div>
              <h3>风险提前一周</h3>
              <p>根据真实推进速度预测延期，而不是等到截止日期才发现问题。</p>
            </div>
          </div>
          <div class="l-cta-band" data-aoi="底部转化">
            <div><b>把下一季度的目标搬进 Orbit</b><span>14 天免费试用 · 无需信用卡</span></div>
            <span class="l-btn">开始免费试用 →</span>
          </div>
          <div class="l-footer" data-aoi="页脚">
            <span>© 2026 Orbit Labs</span>
            <div><span>隐私</span><span>条款</span><span>系统状态</span></div>
            <span>Built for teams that ship.</span>
          </div>
        </div>`,
    },

    dashboard: {
      title: 'Northwind · 增长仪表盘',
      label: '数据仪表盘',
      render: () => `
        <div class="c-dash">
          <aside class="d-rail" data-aoi="侧边导航">
            <div class="d-logo"></div>
            <div class="d-nav on">概览</div>
            <div class="d-nav">增长</div>
            <div class="d-nav">留存</div>
            <div class="d-nav">渠道</div>
            <div class="d-spacer"></div>
            <div class="d-nav">设置</div>
            <div class="d-avatar">YL</div>
          </aside>
          <div class="d-main">
            <div class="d-top" data-aoi="顶部工具栏">
              <div>
                <h2>增长概览</h2>
                <div class="d-crumb">工作区 / Northwind / 2026 Q4</div>
              </div>
              <div class="d-top-right">
                <div class="d-search"><i></i>搜索指标、用户或事件</div>
                <div class="d-ghostbtn">最近 30 天</div>
                <div class="d-new">+ 新建看板</div>
              </div>
            </div>
            <div class="d-kpis" data-aoi="核心指标">
              <div class="d-kpi">
                <div class="d-kpi-h"><span>活跃用户</span><em>+12.4%</em></div>
                <b>48.2<span>k</span></b>
                <div class="d-spark"><i style="height:34%"></i><i style="height:48%"></i><i style="height:42%"></i><i style="height:60%"></i><i style="height:55%"></i><i style="height:74%"></i><i style="height:88%"></i><i style="height:100%"></i></div>
              </div>
              <div class="d-kpi">
                <div class="d-kpi-h"><span>净收入</span><em>+8.1%</em></div>
                <b>182<span>k</span></b>
                <div class="d-spark"><i style="height:44%"></i><i style="height:38%"></i><i style="height:55%"></i><i style="height:50%"></i><i style="height:68%"></i><i style="height:62%"></i><i style="height:82%"></i><i style="height:90%"></i></div>
              </div>
              <div class="d-kpi">
                <div class="d-kpi-h"><span>付费转化</span><em class="down">-1.8%</em></div>
                <b>3.6<span>%</span></b>
                <div class="d-spark"><i style="height:74%"></i><i style="height:82%"></i><i style="height:70%"></i><i style="height:66%"></i><i style="height:58%"></i><i style="height:62%"></i><i style="height:55%"></i><i style="height:50%"></i></div>
              </div>
              <div class="d-kpi">
                <div class="d-kpi-h"><span>流失率</span><em>+0.4%</em></div>
                <b>1.9<span>%</span></b>
                <div class="d-spark"><i style="height:30%"></i><i style="height:34%"></i><i style="height:28%"></i><i style="height:40%"></i><i style="height:36%"></i><i style="height:44%"></i><i style="height:40%"></i><i style="height:48%"></i></div>
              </div>
            </div>
            <div class="d-grid">
              <div class="d-card" data-aoi="趋势图表">
                <div class="d-card-h">
                  <h3>活跃与留存趋势</h3>
                  <div class="d-leg"><span><i style="background:#6366f1"></i>活跃</span><span><i style="background:#22d3ee"></i>留存</span></div>
                </div>
                <div class="d-chart">
                  <svg viewBox="0 0 560 220" fill="none" preserveAspectRatio="none">
                    <defs>
                      <linearGradient id="dArea" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stop-color="#6366f1" stop-opacity=".22"/>
                        <stop offset="100%" stop-color="#6366f1" stop-opacity="0"/>
                      </linearGradient>
                    </defs>
                    <g stroke="#e5e9f2" stroke-width="1">
                      <path d="M0 40h560M0 80h560M0 120h560M0 160h560M0 200h560"/>
                    </g>
                    <path d="M0 156 56 146 112 150 168 120 224 128 280 98 336 104 392 72 448 80 504 54 560 60V220H0Z" fill="url(#dArea)"/>
                    <path d="M0 156 56 146 112 150 168 120 224 128 280 98 336 104 392 72 448 80 504 54 560 60" stroke="#6366f1" stroke-width="2.2"/>
                    <path d="M0 182 56 176 112 178 168 160 224 166 280 146 336 150 392 132 448 138 504 120 560 126" stroke="#22d3ee" stroke-width="1.8" stroke-dasharray="5 4"/>
                    <g fill="#6366f1">
                      <circle cx="168" cy="120" r="3"/><circle cx="392" cy="72" r="3"/><circle cx="504" cy="54" r="3"/>
                    </g>
                    <g font-family="monospace" font-size="8" fill="#9aa1b1">
                      <text x="0" y="216">10/01</text><text x="140" y="216">10/08</text><text x="280" y="216">10/15</text><text x="420" y="216">10/22</text><text x="532" y="216">10/29</text>
                    </g>
                  </svg>
                </div>
                <div class="d-legend"><span><b>+18.6%</b> 周活跃增长</span><span><b>41.2%</b> 次周留存</span></div>
                <div class="d-chart-foot">
                  <div><span>峰值</span><b>2,841</b><small>10/22</small></div>
                  <div><span>平均停留</span><b>3m 12s</b><small>较上周 +18s</small></div>
                  <div><span>回访用户</span><b>41.2%</b><small>稳定</small></div>
                </div>
              </div>
              <div class="d-card" data-aoi="来源分布">
                <div class="d-card-h"><h3>访问来源</h3><span class="d-leg">本月</span></div>
                <div class="d-donut-wrap">
                  <div class="d-donut">
                    <svg viewBox="0 0 42 42">
                      <circle cx="21" cy="21" r="15.9" stroke="#eef1f7" stroke-width="6" fill="none"/>
                      <circle cx="21" cy="21" r="15.9" stroke="#6366f1" stroke-width="6" fill="none" stroke-dasharray="42 58" stroke-dashoffset="0"/>
                      <circle cx="21" cy="21" r="15.9" stroke="#22d3ee" stroke-width="6" fill="none" stroke-dasharray="27 73" stroke-dashoffset="-42"/>
                      <circle cx="21" cy="21" r="15.9" stroke="#a78bfa" stroke-width="6" fill="none" stroke-dasharray="17 83" stroke-dashoffset="-69"/>
                      <circle cx="21" cy="21" r="15.9" stroke="#fbbf24" stroke-width="6" fill="none" stroke-dasharray="14 86" stroke-dashoffset="-86"/>
                    </svg>
                    <div class="d-donut-c"><div><b>48.2k</b><span>总访问</span></div></div>
                  </div>
                  <div class="d-donut-legend">
                    <div><i style="background:#6366f1"></i>自然搜索 42%</div>
                    <div><i style="background:#22d3ee"></i>直接访问 27%</div>
                    <div><i style="background:#a78bfa"></i>社交推荐 17%</div>
                    <div><i style="background:#fbbf24"></i>付费投放 14%</div>
                  </div>
                </div>
                <div class="d-trend">
                  <div class="d-trend-h"><span>近 7 日访问</span><b>+12.4%</b></div>
                  <div class="d-trend-bars"><i style="height:38%"></i><i style="height:52%"></i><i style="height:46%"></i><i style="height:63%"></i><i style="height:58%"></i><i style="height:75%"></i><i style="height:92%"></i></div>
                </div>
                <div class="d-toplist">
                  <div class="d-toplist-h"><span>热门页面</span><span>浏览占比</span></div>
                  <div class="d-toprow"><span>/pricing</span><i><b style="width:84%"></b></i><em>24%</em></div>
                  <div class="d-toprow"><span>/docs/start</span><i><b style="width:67%"></b></i><em>18%</em></div>
                  <div class="d-toprow"><span>/integrations</span><i><b style="width:48%"></b></i><em>13%</em></div>
                  <div class="d-toprow"><span>/blog/growth</span><i><b style="width:36%"></b></i><em>9%</em></div>
                  <div class="d-toprow"><span>/changelog</span><i><b style="width:28%"></b></i><em>7%</em></div>
                </div>
              </div>
            </div>
            <div class="d-bottom">
              <div class="d-card" data-aoi="渠道质量">
                <div class="d-card-h"><h3>渠道质量</h3><span class="d-leg">转化 / 成本</span></div>
                <div class="d-source">
                  <div class="d-source-row"><span>自然搜索</span><div class="d-source-bar"><i style="width:86%"></i></div><b>4.8%</b></div>
                  <div class="d-source-row"><span>产品推荐</span><div class="d-source-bar"><i style="width:68%"></i></div><b>3.9%</b></div>
                  <div class="d-source-row"><span>社交内容</span><div class="d-source-bar"><i style="width:44%"></i></div><b>2.6%</b></div>
                  <div class="d-source-row"><span>付费投放</span><div class="d-source-bar"><i style="width:31%"></i></div><b>1.7%</b></div>
                </div>
              </div>
              <div class="d-card" data-aoi="事件列表">
                <div class="d-card-h"><h3>最近事件</h3><span class="d-leg">实时</span></div>
                <table class="d-table">
                  <thead><tr><th>事件</th><th>用户</th><th>渠道</th><th>状态</th></tr></thead>
                  <tbody>
                    <tr><td>完成引导流程</td><td>u_2841</td><td>自然搜索</td><td><span class="d-status"><i></i>成功</span></td></tr>
                    <tr><td>升级到团队版</td><td>u_1932</td><td>产品推荐</td><td><span class="d-status"><i></i>成功</span></td></tr>
                    <tr><td>创建首个看板</td><td>u_3104</td><td>社交内容</td><td><span class="d-status"><i></i>成功</span></td></tr>
                    <tr><td>试用到期提醒</td><td>u_0788</td><td>付费投放</td><td><span class="d-status warn"><i></i>待处理</span></td></tr>
                  </tbody>
                </table>
              </div>
            </div>
            <div class="d-statusbar">
              <span><i></i>所有系统正常</span>
              <span>数据更新于 2 分钟前</span>
              <span>下一次同步 00:58</span>
            </div>
          </div>
        </div>`,
    },
  };

  /* ============================================================
     状态
     ============================================================ */
  const S = {
    content: 'article',
    view: 'heat',
    engine: 'none',          // none | starting | webgazer | demo | error
    tracking: false,
    recording: false,
    calibrating: false,
    recStartAt: 0,
    sessionMs: 0,
    data: {},                // contentId -> { points, counts, inStage, allGaze, startedAt }
    aois: [],
    stageScale: 1,
    stageRect: null,
    gaze: { x: 0, y: 0, live: false, ts: 0 },
    filter: { hist: [], x: null, y: null, ox: null, oy: null },
    blinkActive: false,
    blinkUntil: 0,
    blinkFrames: 0,
    head: null,
    calibView: null,
    calibStale: false,
    headRef: null,
    miniHidden: false,
    miniIdle: false,
    lastHeadProbe: 0,
    hasPrediction: false,
    lastAccepted: null,
    lastStamp: 0,
    fpsCounter: { frames: 0, last: now() },
    fps: 0,
    radius: 72,
    intensity: 1,
    dirty: true,
    lastRender: 0,
    heatDirty: true,
    speed: 0,
    booted: false,
    demoHandler: null,
    wgStarted: false,
    stare: null,
    calibFrames: 0,
    validating: false,
    validationResults: [],
    calibReport: null,
    pendingResume: false,
    resumeAfterGuide: false,
    guide: {
      open: false,
      mesh: null,
      stream: null,
      shared: false,
      results: null,
      history: [],
      stableSince: 0,
      session: 0,
      ready: false,
      meshFailed: false,
      pausedWg: false,
    },
  };

  /* ============================================================
     DOM
     ============================================================ */
  const el = {
    stage: $('#stage'),
    stageWrap: $('#stageWrap'),
    content: $('#content'),
    contentTitle: $('#contentTitle'),
    stageEmpty: $('#stageEmpty'),
    liveBadge: $('#liveBadge'),
    liveTime: $('#liveTime'),
    heat: $('#heatCanvas'),
    track: $('#trackCanvas'),
    cursor: $('#gazeCursor'),
    pillEngine: $('#pillEngine'),
    pillFps: $('#pillFps'),
    pillRec: $('#pillRec'),
    engineTag: $('#engineTag'),
    statPoints: $('#statPoints'),
    statDuration: $('#statDuration'),
    statAoi: $('#statAoi'),
    statHit: $('#statHit'),
    hitBar: $('#hitBar'),
    aoiList: $('#aoiList'),
    aoiTotal: $('#aoiTotal'),
    radius: $('#radius'),
    radiusOut: $('#radiusOut'),
    intensity: $('#intensity'),
    intensityOut: $('#intensityOut'),
    btnStart: $('#btnStart'),
    btnRecord: $('#btnRecord'),
    btnCalib: $('#btnCalib'),
    btnDemo: $('#btnDemo'),
    btnCsv: $('#btnCsv'),
    btnPng: $('#btnPng'),
    btnClear: $('#btnClear'),
    calibOverlay: $('#calibOverlay'),
    calibStage: $('#calibStage'),
    calibCount: $('#calibCount'),
    calibTotal: $('#calibTotal'),
    calibNote: $('#calibNote'),
    calibStatus: $('#calibStatus'),
    calibPulse: $('#calibPulse'),
    calibArea: $('#calibArea'),
    miniCam: $('#miniCam'),
    miniVideo: $('#miniVideo'),
    miniCanvas: $('#miniCanvas'),
    miniBadge: $('#miniBadge'),
    miniTilt: $('#miniTilt'),
    miniClose: $('#miniClose'),
    miniOpen: $('#miniOpen'),
    qualityTag: $('#calibQualityTag'),
    calibScore: $('#calibScore'),
    calibGrade: $('#calibGrade'),
    calibSummary: $('#calibSummary'),
    calibAvgErr: $('#calibAvgErr'),
    calibMaxErr: $('#calibMaxErr'),
    calibValidFrames: $('#calibValidFrames'),
    calibPointList: $('#calibPointList'),
    calibQualityHint: $('#calibQualityHint'),
    btnValidate: $('#btnValidate'),
    reportOverlay: $('#reportOverlay'),
    reportScore: $('#reportScore'),
    reportGrade: $('#reportGrade'),
    reportSummary: $('#reportSummary'),
    reportAvg: $('#reportAvg'),
    reportMax: $('#reportMax'),
    reportStability: $('#reportStability'),
    reportFrames: $('#reportFrames'),
    reportPoints: $('#reportPoints'),
    reportNote: $('#reportNote'),
    btnReportClose: $('#btnReportClose'),
    btnReportRecal: $('#btnReportRecal'),
    btnReportDone: $('#btnReportDone'),
    guideOverlay: $('#guideOverlay'),
    guideVideo: $('#guideVideo'),
    guideBox: $('#guideBox'),
    guideBoxLabel: $('#guideBox .guide-box-label'),
    guideLoading: $('#guideLoading'),
    guideChecks: $('#guideChecks'),
    guideHint: $('#guideHint'),
    btnGuideStart: $('#btnGuideStart'),
    btnGuideSkip: $('#btnGuideSkip'),
    helpOverlay: $('#helpOverlay'),
    toast: $('#toast'),
  };

  const heatCtx = el.heat.getContext('2d');
  const trackCtx = el.track.getContext('2d');

  const accum = document.createElement('canvas');
  accum.width = HEAT_W;
  accum.height = HEAT_H;
  const accumCtx = accum.getContext('2d', { willReadFrequently: true });
  accumCtx.clearRect(0, 0, HEAT_W, HEAT_H);
  accumCtx.globalCompositeOperation = 'lighter';

  /* ============================================================
     热力色标
     ============================================================ */
  const STOPS = [
    [0.00, 44, 123, 182, 0],
    [0.12, 44, 123, 182, 0.42],
    [0.28, 0, 166, 166, 0.56],
    [0.46, 123, 192, 67, 0.70],
    [0.62, 255, 217, 47, 0.82],
    [0.80, 244, 119, 46, 0.90],
    [1.00, 200, 18, 24, 0.95],
  ];
  const LUT = new Uint8ClampedArray(256 * 4);
  (function buildLut() {
    for (let i = 0; i < 256; i++) {
      const v = i / 255;
      let a = STOPS[0], b = STOPS[STOPS.length - 1];
      for (let s = 0; s < STOPS.length - 1; s++) {
        if (v >= STOPS[s][0] && v <= STOPS[s + 1][0]) { a = STOPS[s]; b = STOPS[s + 1]; break; }
      }
      const span = b[0] - a[0] || 1;
      const k = (v - a[0]) / span;
      LUT[i * 4] = a[1] + (b[1] - a[1]) * k;
      LUT[i * 4 + 1] = a[2] + (b[2] - a[2]) * k;
      LUT[i * 4 + 2] = a[3] + (b[3] - a[3]) * k;
      LUT[i * 4 + 3] = (a[4] + (b[4] - a[4]) * k) * 255;
    }
  })();

  /* ============================================================
     数据
     ============================================================ */
  function blankData() {
    return { points: [], counts: {}, inStage: 0, allGaze: 0, startedAt: 0, lastT: 0 };
  }
  function getData(id = S.content) {
    if (!S.data[id]) S.data[id] = blankData();
    return S.data[id];
  }

  /* ============================================================
     内容 / 舞台布局
     ============================================================ */
  function renderContent(id, opts = {}) {
    const def = CONTENT_DEFS[id];
    if (!def) return;
    S.content = id;
    resetGazeFilter();
    S.lastAccepted = null;
    S.gaze.live = false;
    el.cursor.classList.remove('live');
    el.content.innerHTML = def.render();
    el.contentTitle.textContent = def.title;
    $$('#contentSwitch button').forEach((b) => {
      b.classList.toggle('on', b.dataset.content === id);
    });
    requestAnimationFrame(() => {
      layoutStage();
      measureAoi();
      rebuildHeat();
      renderTrack();
      updateStats(true);
    });
    if (!opts.silent) {
      const has = getData(id).points.length;
      if (has) toast('已切换到「' + def.label + '」，载入该内容已有的 ' + has + ' 个样本');
    }
    // 内容预览不再用空状态条遮住底栏；提示保留在舞台下方
    el.stageEmpty.classList.add('hide');
  }

  function layoutStage() {
    const wrap = el.stageWrap;
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    if (!w || !h) return;
    const pad = 22;
    const s = Math.min((w - pad) / STAGE_W, (h - pad) / STAGE_H);
    S.stageScale = Math.max(0.15, s);
    el.stage.style.setProperty('--stage-scale', S.stageScale.toFixed(5));
    S.stageRect = el.stage.getBoundingClientRect();
  }

  function measureAoi() {
    const sr = S.stageRect;
    if (!sr || !sr.width) { S.aois = []; return; }
    const s = sr.width / STAGE_W;
    S.aois = $$('[data-aoi]', el.content)
      .map((node) => {
        const r = node.getBoundingClientRect();
        const a = {
          name: node.dataset.aoi,
          x: (r.left - sr.left) / s,
          y: (r.top - sr.top) / s,
          w: r.width / s,
          h: r.height / s,
        };
        return a;
      })
      .filter((a) => a.w > 4 && a.h > 4)
      .sort((a, b) => a.w * a.h - b.w * b.h);
  }

  function hitAoi(x, y) {
    for (const a of S.aois) {
      if (x >= a.x && x <= a.x + a.w && y >= a.y && y <= a.y + a.h) return a.name;
    }
    return '背景';
  }

  /* ============================================================
     视线输入
     ============================================================ */
  function clientToStage(cx, cy) {
    const r = S.stageRect;
    if (!r || !r.width) return null;
    const s = r.width / STAGE_W;
    return { x: (cx - r.left) / s, y: (cy - r.top) / s };
  }


  function resetGazeFilter() {
    S.filter = { hist: [], x: null, y: null, ox: null, oy: null };
    S.blinkActive = false;
    S.blinkUntil = 0;
    S.blinkFrames = 0;
  }

  function eyeEar(pos, idx) {
    const p1 = pos[idx[0]], p2 = pos[idx[1]], p3 = pos[idx[2]];
    const p4 = pos[idx[3]], p5 = pos[idx[4]], p6 = pos[idx[5]];
    if (!p1 || !p2 || !p3 || !p4 || !p5 || !p6) return 0;
    const v1 = Math.hypot(p2[0] - p6[0], p2[1] - p6[1]);
    const v2 = Math.hypot(p3[0] - p5[0], p3[1] - p5[1]);
    const h = Math.hypot(p1[0] - p4[0], p1[1] - p4[1]);
    return h > 0.0001 ? (v1 + v2) / (2 * h) : 0;
  }

  /**
   * 直接复用 WebGazer 自己的 facemesh 关键点，不额外跑模型。
   * 返回归一化的人脸框、头部姿态和眨眼状态，供小窗和采样过滤使用。
   */
  function readHead() {
    const wg = window.webgazer;
    if (!wg || typeof wg.getTracker !== 'function') return null;
    let tracker = null;
    try { tracker = wg.getTracker(); } catch (err) { return null; }
    if (!tracker || typeof tracker.getPositions !== 'function') return null;
    let pos = null;
    try { pos = tracker.getPositions(); } catch (err) { return null; }
    if (!pos || pos.length < 468) return null;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < pos.length; i++) {
      const p = pos[i];
      if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
      if (p[0] < minX) minX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] > maxY) maxY = p[1];
    }
    if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return null;

    // WebGazer 的 scaledMesh 使用摄像头原始分辨率，不是 320×240 预览尺寸
    const wgVideo = document.getElementById('webgazerVideoFeed');
    let vw = (wgVideo && wgVideo.videoWidth) || 640;
    let vh = (wgVideo && wgVideo.videoHeight) || 480;
    // 兼容返回归一化坐标的实现
    if (Math.max(maxX, maxY) <= 1.35) { vw = 1; vh = 1; }
    if (vw <= 0 || vh <= 0) { vw = 640; vh = 480; }

    const faceW = (maxX - minX) / vw;
    const faceH = (maxY - minY) / vh;
    const cx = (minX + maxX) / 2 / vw;
    const cy = (minY + maxY) / 2 / vh;

    const left = pos[33], right = pos[263], nose = pos[1];
    let roll = 0, yaw = 0, pitch = 0;
    let eyes = null;
    if (left && right && nose) {
      const lx = left[0] / vw, ly = left[1] / vh;
      const rx = right[0] / vw, ry = right[1] / vh;
      const eyeMidX = (lx + rx) / 2;
      const eyeMidY = (ly + ry) / 2;
      const eyeSpan = Math.max(0.035, Math.hypot(rx - lx, ry - ly));
      // 眼睛连线与水平线的夹角：真正意义的头部左右倾斜（roll）
      roll = Math.atan2(ry - ly, rx - lx) * 180 / Math.PI;
      // 鼻尖相对眼中心的水平偏移近似左右转头（yaw）
      yaw = Math.atan2(nose[0] / vw - eyeMidX, eyeSpan) * 180 / Math.PI;
      // 鼻尖相对眼中心的垂直比例近似俯仰（pitch），用于与标定基准比较
      pitch = Math.atan2((nose[1] / vh - eyeMidY) / eyeSpan, 1) * 180 / Math.PI;
      eyes = { lx, ly, rx, ry };
    }

    const earL = eyeEar(pos, [33, 160, 158, 133, 153, 144]);
    const earR = eyeEar(pos, [362, 385, 387, 263, 373, 380]);
    const ear = Math.max(0, (earL + earR) / 2);
    const blink = ear > 0 && ear < 0.17;

    const distanceOk = faceH >= 0.22 && faceH <= 0.80;
    const centerOk = Math.abs(cx - 0.5) <= 0.17 && Math.abs(cy - 0.5) <= 0.20;
    const poseOk = Math.abs(roll) <= 12 && Math.abs(yaw) <= 17 && pitch >= 5 && pitch <= 68;

    let refOk = true;
    let refDist = 0;
    let dRoll = 0, dYaw = 0, dPitch = 0;
    if (S.headRef) {
      const dx = cx - S.headRef.cx;
      const dy = cy - S.headRef.cy;
      const dh = faceH - S.headRef.faceH;
      refDist = Math.hypot(dx, dy * 1.1, dh * 0.8);
      dRoll = roll - S.headRef.roll;
      dYaw = yaw - S.headRef.yaw;
      dPitch = pitch - S.headRef.pitch;
      refOk = Math.abs(dx) <= 0.055 &&
        Math.abs(dy) <= 0.065 &&
        Math.abs(dh) <= 0.10 &&
        Math.abs(dRoll) <= 5 &&
        Math.abs(dYaw) <= 7 &&
        Math.abs(dPitch) <= 8;
    }

    return {
      faceW, faceH, cx, cy, roll, yaw, pitch, dRoll, dYaw, dPitch, eyes,
      earL, earR, ear, blink,
      distanceOk, centerOk, poseOk, refOk, refDist,
      ok: distanceOk && centerOk && poseOk && !blink,
      box: { x: cx - faceW / 2, y: cy - faceH / 2, w: faceW, h: faceH },
    };
  }

  function filterGaze(cx, cy, t, head, source) {
    if (source !== 'webgazer') return { x: cx, y: cy, blink: false };
    const hold = () => ({
      x: S.filter.x == null ? cx : S.filter.x,
      y: S.filter.y == null ? cy : S.filter.y,
      blink: true,
    });

    if (head && head.blink) {
      S.blinkActive = true;
      S.blinkUntil = t + 140;
      S.filter.hist.length = 0;
      return hold();
    }
    if (S.blinkActive) {
      S.blinkActive = false;
      S.blinkFrames = 2;
    }
    if (t < S.blinkUntil || S.blinkFrames > 0) {
      if (S.blinkFrames > 0) S.blinkFrames--;
      return hold();
    }

    S.filter.hist.push({ x: cx, y: cy });
    if (S.filter.hist.length > 3) S.filter.hist.shift();
    const xs = S.filter.hist.map((p) => p.x).sort((a, b) => a - b);
    const ys = S.filter.hist.map((p) => p.y).sort((a, b) => a - b);
    const mx = xs[Math.floor(xs.length / 2)];
    const my = ys[Math.floor(ys.length / 2)];

    if (S.filter.x == null) {
      S.filter.x = mx;
      S.filter.y = my;
    } else {
      const dist = Math.hypot(mx - S.filter.x, my - S.filter.y);
      // 小动作压住抖动，大跳变迅速跟上
      const alpha = dist < 3 ? 0.10 : dist > 110 ? 0.55 : 0.10 + ((dist - 3) / 107) * 0.45;
      S.filter.x += (mx - S.filter.x) * alpha;
      S.filter.y += (my - S.filter.y) * alpha;
    }

    if (S.filter.ox == null || Math.hypot(S.filter.x - S.filter.ox, S.filter.y - S.filter.oy) >= 1.2) {
      S.filter.ox = S.filter.x;
      S.filter.oy = S.filter.y;
    }
    return { x: S.filter.ox, y: S.filter.oy, blink: false };
  }

  function bindMiniStream() {
    if (!el.miniVideo) return false;
    const wgVideo = document.getElementById('webgazerVideoFeed');
    if (!wgVideo || !wgVideo.srcObject) return false;
    if (el.miniVideo.srcObject !== wgVideo.srcObject) {
      el.miniVideo.srcObject = wgVideo.srcObject;
      try { el.miniVideo.play(); } catch (err) { /* noop */ }
    }
    if (!S.miniHidden) {
      el.miniCam.classList.add('show');
      el.miniCam.setAttribute('aria-hidden', 'false');
      el.miniOpen.classList.remove('show');
    }
    return true;
  }

  function showMiniFallback() {
    if (!el.miniCam || S.miniHidden) return;
    el.miniCam.classList.add('show');
    updateMiniBadge('等待画面', 'bad');
  }

  function updateMiniBadge(text, tone) {
    if (!el.miniBadge) return;
    const span = el.miniBadge.querySelector('span');
    if (span) span.textContent = text;
    el.miniBadge.classList.remove('warn', 'bad');
    if (tone === 'warn') el.miniBadge.classList.add('warn');
    else if (tone === 'bad') el.miniBadge.classList.add('bad');
  }

  function updateMini(head) {
    if (!el.miniCanvas || !el.miniCam.classList.contains('show')) return;
    const c = el.miniCanvas;
    const w = c.clientWidth || 200;
    const h = c.clientHeight || 150;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    if (!head) {
      updateMiniBadge('未检测到人脸', 'bad');
      if (el.miniTilt) {
        el.miniTilt.querySelector('b').textContent = '倾斜 --';
        el.miniTilt.querySelector('span').textContent = '转头 -- · 俯仰 --';
        el.miniTilt.classList.add('warn');
      }
      return;
    }

    // 虚线框 = 标定开始时的头部参考位置
    if (S.headRef) {
      const g = S.headRef.box;
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(255,255,255,.5)';
      // 画在实线框外侧，重合时也能看到“标定位置”目标区
      ctx.strokeRect(g.x * w - 4, g.y * h - 4, g.w * w + 8, g.h * h + 8);
      ctx.restore();
    }

    const box = head.box;
    const tone = head.blink ? 'warn' : head.ok && head.refOk ? 'ok' : 'warn';
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = head.blink
      ? 'rgba(255,196,107,.85)'
      : head.ok && head.refOk ? 'rgba(116,240,206,.92)' : 'rgba(255,142,142,.9)';
    ctx.strokeRect(
      Math.max(0, box.x) * w,
      Math.max(0, box.y) * h,
      Math.min(1 - Math.max(0, box.x), box.w) * w,
      Math.min(1 - Math.max(0, box.y), box.h) * h
    );

    // 眼线 + 水平参考线：直接看出头部左右倾斜
    if (head.eyes) {
      const e = head.eyes;
      const midY = ((e.ly + e.ry) / 2) * h;
      ctx.save();
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 3]);
      ctx.strokeStyle = 'rgba(255,255,255,.18)';
      ctx.beginPath();
      ctx.moveTo(5, midY);
      ctx.lineTo(w - 5, midY);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeStyle = 'rgba(116,240,206,.55)';
      ctx.beginPath();
      ctx.moveTo(e.lx * w, e.ly * h);
      ctx.lineTo(e.rx * w, e.ry * h);
      ctx.stroke();
      ctx.fillStyle = 'rgba(116,240,206,.8)';
      ctx.beginPath(); ctx.arc(e.lx * w, e.ly * h, 1.6, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(e.rx * w, e.ry * h, 1.6, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    if (el.miniTilt) {
      const sign = (v) => { const x = Math.abs(v) < 0.05 ? 0 : v; return (x >= 0 ? '+' : '') + x.toFixed(1) + '°'; };
      el.miniTilt.querySelector('b').textContent = '倾 ' + sign(head.roll) + ' · 转 ' + sign(head.yaw);
      const dev = S.headRef
        ? Math.hypot(head.dRoll, head.dYaw, head.dPitch)
        : 0;
      el.miniTilt.querySelector('span').textContent = S.headRef
        ? '俯Δ ' + sign(head.dPitch) + ' · 综合偏 ' + dev.toFixed(1) + '°'
        : '俯仰 --';
      el.miniTilt.classList.toggle('warn', !head.poseOk || (!!S.headRef && !head.refOk));
    }

    if (head.blink) updateMiniBadge('眨眼，暂停采样', 'warn');
    else if (!head.distanceOk) updateMiniBadge(head.faceH < 0.22 ? '请靠近一点' : '稍微离远一点', 'warn');
    else if (!head.centerOk) updateMiniBadge('请回到画面中央', 'warn');
    else if (Math.abs(head.roll) > 12) updateMiniBadge('头歪了 · 请回正', 'warn');
    else if (!head.poseOk) updateMiniBadge('请正对屏幕', 'warn');
    else if (S.headRef && !head.refOk) updateMiniBadge('头位偏了 · 请回正', 'warn');
    else updateMiniBadge('头部稳定', tone);
  }

  function clearMiniFace() {
    if (!el.miniCanvas) return;
    const ctx = el.miniCanvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, el.miniCanvas.width, el.miniCanvas.height);
    updateMiniBadge('未检测到人脸', 'bad');
    if (el.miniTilt) {
      el.miniTilt.querySelector('b').textContent = '倾斜 --';
      el.miniTilt.querySelector('span').textContent = '转头 -- · 俯仰 --';
      el.miniTilt.classList.add('warn');
    }
  }

  function clampCursorToStage(cx, cy) {
    const r = S.stageRect;
    if (!r || !r.width || !r.height) return { x: cx, y: cy };
    const m = 4;
    return {
      x: clamp(cx, r.left + m, r.right - m),
      y: clamp(cy, r.top + m, r.bottom - m),
    };
  }

  function onGaze(cx, cy, t, source) {
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) return;
    S.fpsCounter.frames++;

    const head = source === 'webgazer' ? readHead() : null;
    if (source === 'webgazer') S.hasPrediction = true;
    if (head) { S.head = head; S.miniIdle = false; }
    if (source === 'webgazer' && head) updateMini(head);

    const f = filterGaze(cx, cy, t, head, source);
    const fx = f.x;
    const fy = f.y;

    // 视线光标（使用滤波后的坐标，眨眼时保持不动）
    S.gaze.x = fx;
    S.gaze.y = fy;
    S.gaze.ts = t;
    S.gaze.live = true;
    const shown = clampCursorToStage(fx, fy);
    el.cursor.style.left = shown.x + 'px';
    el.cursor.style.top = shown.y + 'px';
    el.cursor.classList.toggle('rec', S.recording);
    el.cursor.classList.add('live');

    if (source === 'demo' || source === 'demo-idle') el.cursor.classList.add('demo');

    if (!S.recording || S.calibrating) return;

    const p = clientToStage(fx, fy);
    if (!p) return;
    const inside = p.x >= -12 && p.y >= -12 && p.x <= STAGE_W + 12 && p.y <= STAGE_H + 12;
    const d = getData();
    d.allGaze++;
    if (inside) d.inStage++;

    if (!inside) { S.filter.hist.length = 0; return; }
    // 头部偏离标定位置时仍显示光标，但不写入热图，避免把偏差样本算进去
    if (S.headRef && head && !head.refOk) return;
    addSample(p.x, p.y, fx, fy, t, f.blink);
  }

  function addSample(sx, sy, cx, cy, t, blink) {
    if (blink) return;
    if (t - S.lastStamp < 40) return;

    if (S.lastAccepted) {
      const dt = t - S.lastAccepted.t;
      const dist = Math.hypot(cx - S.lastAccepted.cx, cy - S.lastAccepted.cy);
      if (dt < 140 && dist > 380) return;
    }

    const x = clamp(sx, 0, STAGE_W);
    const y = clamp(sy, 0, STAGE_H);
    const aoi = hitAoi(x, y);
    const d = getData();

    if (!d.startedAt) d.startedAt = t - S.recStartAt;
    const relT = Math.round(t - S.recStartAt);
    d.points.push({ t: relT, x: +x.toFixed(1), y: +y.toFixed(1), aoi });
    d.counts[aoi] = (d.counts[aoi] || 0) + 1;
    d.lastT = relT;

    S.lastStamp = t;
    S.lastAccepted = { x, y, cx, cy, t };

    stampPoint(x, y);
    S.heatDirty = true;
    S.dirty = true;
  }

  /* ============================================================
     热力图
     ============================================================ */
  function stampPoint(x, y) {
    const cx = x * HEAT_SCALE;
    const cy = y * HEAT_SCALE;
    const r = Math.max(7, S.radius * HEAT_SCALE);
    const a = 0.03 * S.intensity;
    const g = accumCtx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, 'rgba(255,255,255,' + a.toFixed(4) + ')');
    g.addColorStop(0.42, 'rgba(255,255,255,' + (a * 0.62).toFixed(4) + ')');
    g.addColorStop(0.72, 'rgba(255,255,255,' + (a * 0.24).toFixed(4) + ')');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    accumCtx.fillStyle = g;
    accumCtx.fillRect(cx - r, cy - r, r * 2, r * 2);
  }

  function rebuildHeat() {
    accumCtx.globalCompositeOperation = 'source-over';
    accumCtx.clearRect(0, 0, HEAT_W, HEAT_H);
    accumCtx.globalCompositeOperation = 'lighter';
    const pts = getData().points;
    const stride = pts.length > 6000 ? 2 : 1;
    for (let i = 0; i < pts.length; i += stride) {
      stampPoint(pts[i].x, pts[i].y);
    }
    S.heatDirty = true;
    S.dirty = true;
    renderHeat();
  }

  function renderHeat() {
    const img = accumCtx.getImageData(0, 0, HEAT_W, HEAT_H);
    const src = img.data;
    const out = heatCtx.createImageData(HEAT_W, HEAT_H);
    const dst = out.data;
    for (let i = 0; i < src.length; i += 4) {
      const v = src[i + 3];
      if (v < 7) { dst[i + 3] = 0; continue; }
      const l = v * 4;
      dst[i] = LUT[l];
      dst[i + 1] = LUT[l + 1];
      dst[i + 2] = LUT[l + 2];
      dst[i + 3] = LUT[l + 3];
    }
    heatCtx.putImageData(out, 0, 0);
  }

  /* ============================================================
     轨迹 / 点阵
     ============================================================ */
  function renderTrack() {
    const pts = getData().points;
    trackCtx.clearRect(0, 0, STAGE_W, STAGE_H);
    if (!pts.length) return;

    if (S.view === 'points') {
      trackCtx.fillStyle = 'rgba(190, 24, 60, .5)';
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        trackCtx.beginPath();
        trackCtx.arc(p.x, p.y, 1.7, 0, Math.PI * 2);
        trackCtx.fill();
      }
      markEnds(pts);
      return;
    }

    const t0 = pts[0].t;
    const t1 = pts[pts.length - 1].t || t0 + 1;
    let prev = null;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (prev && p.t - prev.t < 320) {
        const k = (p.t - t0) / (t1 - t0 || 1);
        trackCtx.strokeStyle = 'hsla(' + Math.round(206 - 206 * k) + ',78%,42%,.62)';
        trackCtx.lineWidth = 1.5;
        trackCtx.beginPath();
        trackCtx.moveTo(prev.x, prev.y);
        trackCtx.lineTo(p.x, p.y);
        trackCtx.stroke();
      }
      if (i % 10 === 0) {
        trackCtx.fillStyle = 'rgba(15, 23, 42, .45)';
        trackCtx.beginPath();
        trackCtx.arc(p.x, p.y, 1.35, 0, Math.PI * 2);
        trackCtx.fill();
      }
      prev = p;
    }
    markEnds(pts);
  }

  function markEnds(pts) {
    const a = pts[0];
    const b = pts[pts.length - 1];
    if (pts.length < 2) return;
    trackCtx.lineWidth = 2;
    trackCtx.strokeStyle = 'rgba(13, 148, 136, .95)';
    trackCtx.beginPath();
    trackCtx.arc(a.x, a.y, 6, 0, Math.PI * 2);
    trackCtx.stroke();
    trackCtx.strokeStyle = 'rgba(190, 18, 60, .95)';
    trackCtx.beginPath();
    trackCtx.arc(b.x, b.y, 6, 0, Math.PI * 2);
    trackCtx.stroke();
    trackCtx.font = '10px ui-monospace, monospace';
    trackCtx.fillStyle = 'rgba(13, 148, 136, .95)';
    trackCtx.fillText('START', a.x + 9, a.y + 3);
    trackCtx.fillStyle = 'rgba(190, 18, 60, .95)';
    trackCtx.fillText('END', b.x + 9, b.y + 3);
  }

  /* ============================================================
     引擎 / 记录状态
     ============================================================ */
  let toastTimer = 0;
  function toast(msg, kind = '') {
    el.toast.textContent = msg;
    el.toast.className = 'toast show ' + kind;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.toast.className = 'toast ' + kind;
    }, 3400);
  }

  function setEngine(engine) {
    S.engine = engine;
    const p = el.pillEngine;
    p.className = 'pill';
    const span = p.querySelector('span');
    if (engine === 'starting') {
      p.classList.add('warn');
      span.textContent = '正在启动摄像头…';
      el.engineTag.textContent = 'STARTING';
    } else if (engine === 'webgazer') {
      p.classList.add('on');
      span.textContent = 'WebGazer 就绪';
      el.engineTag.textContent = 'WEBGAZER 2.1.2';
      el.engineTag.classList.add('live');
    } else if (engine === 'demo') {
      p.classList.add('warn');
      span.textContent = '演示模式 · 鼠标模拟';
      el.engineTag.textContent = 'DEMO INPUT';
      el.engineTag.classList.add('live');
      el.pillFps.querySelector('span').textContent = 'DEMO';
    } else if (engine === 'error') {
      p.classList.add('err');
      span.textContent = '追踪不可用';
      el.engineTag.textContent = 'ERROR';
    } else {
      span.textContent = '追踪未启动';
      el.engineTag.textContent = '未连接';
      el.engineTag.classList.remove('live');
      el.pillFps.querySelector('span').textContent = '-- FPS';
    }
    if (engine !== 'webgazer' && engine !== 'demo') {
      el.engineTag.classList.remove('live');
      el.pillFps.classList.remove('on');
    }
    el.btnRecord.disabled = !S.tracking;
    el.btnCalib.disabled = engine !== 'webgazer';
  }

  function startTracking() {
    el.stageEmpty.classList.add('hide');
    if (S.engine === 'webgazer') { openGuide(); return; }
    if (S.engine === 'starting') return;
    if (S.engine === 'demo') disableDemo(true);

    if (S.wgStarted) {
      try { window.webgazer.resume(); } catch (e) { /* noop */ }
      S.tracking = true;
      setEngine('webgazer');
      el.btnStart.textContent = '重新标定';
      toast('已恢复摄像头追踪，先确认头部位置。', 'ok');
      openGuide();
      return;
    }
    if (!window.webgazer) {
      setEngine('error');
      toast('WebGazer 脚本未加载。请确认 vendor/webgazer/webgazer.js 存在，并通过 localhost 访问页面。', 'err');
      return;
    }
    setEngine('starting');
    el.btnStart.disabled = true;

    try { window.webgazer.setRegression('ridge'); } catch (e) { /* noop */ }
    try {
      window.webgazer.showVideoPreview(false);
      window.webgazer.showFaceOverlay(false);
      window.webgazer.showFaceFeedbackBox(false);
      window.webgazer.showPredictionPoints(false);
    } catch (e) { /* noop */ }

    window.webgazer.setGazeListener((data) => {
      if (!data) return;
      onGaze(data.x, data.y, now(), 'webgazer');
    });

    window.webgazer.begin()
      .then(() => {
        try { window.webgazer.removeMouseEventListeners(); } catch (e) { /* noop */ }
        try {
          window.webgazer.showVideoPreview(false);
          window.webgazer.showFaceOverlay(false);
          window.webgazer.showFaceFeedbackBox(false);
          window.webgazer.showPredictionPoints(false);
        } catch (e) { /* noop */ }
        S.tracking = true;
        S.wgStarted = true;
        setEngine('webgazer');
        S.hasPrediction = false;
        S.headRef = null;
        resetQuality('未标定');
        el.btnStart.textContent = '重新标定';
        el.btnStart.disabled = false;
        S.miniHidden = false;
        el.miniOpen.classList.remove('show');
        let miniTries = 0;
        const tryMini = () => {
          if (bindMiniStream()) return;
          if (miniTries++ < 5) setTimeout(tryMini, 400);
          else showMiniFallback();
        };
        setTimeout(tryMini, 250);
        toast('摄像头已就绪，先调整头部位置，再开始标定。', 'ok');
        openGuide();
      })
      .catch((err) => {
        S.tracking = false;
        setEngine('error');
        el.btnStart.disabled = false;
        const msg = (err && (err.message || err.name)) || String(err);
        toast('摄像头启动失败：' + msg + '。请检查授权，或使用「演示模式」体验完整流程。', 'err');
      });
  }

  function enableDemo() {
    if (S.engine === 'demo') { disableDemo(); return; }
    if (S.engine === 'webgazer') {
      try { window.webgazer.pause(); } catch (e) { /* noop */ }
    }
    S.engine = 'demo';
    S.tracking = true;
    el.miniCam.classList.remove('show');
    el.miniOpen.classList.remove('show');
    setEngine('demo');
    el.btnDemo.textContent = '退出演示';
    el.btnDemo.classList.add('on');
    el.btnStart.textContent = '启动视线追踪';
    startRecording(true);
    if (!S.demoHandler) {
      S.demoHandler = (e) => {
        const target = e.target;
        if (target && target.closest && target.closest('.topbar, .side, .calib, .modal, .stage-head, .stage-foot')) return;
        const r = S.stageRect;
        if (!r) return;
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
        const t = now();
        if (t - (S.demoLast || 0) < 42) return;
        S.demoLast = t;
        onGaze(e.clientX, e.clientY, t, 'demo');
      };
      window.addEventListener('mousemove', S.demoHandler);
    }
    el.stageEmpty.classList.add('hide');
    toast('演示模式：在内容区移动鼠标，即可像注视一样累积热力图。', 'ok');
  }

  function disableDemo(silent) {
    if (S.demoHandler) {
      window.removeEventListener('mousemove', S.demoHandler);
      S.demoHandler = null;
    }
    el.btnDemo.textContent = '演示模式';
    el.btnDemo.classList.remove('on');
    el.cursor.classList.remove('demo');
    if (S.engine === 'demo') {
      S.engine = 'none';
      S.tracking = false;
      pauseRecording(true);
      setEngine('none');
    }
    if (!silent) toast('已退出演示模式');
  }

  function startRecording(fromDemo) {
    if (!S.tracking) {
      toast('请先启动视线追踪，或使用演示模式。');
      return;
    }
    if (S.recording) return;
    if (!S.sessionMs) S.sessionMs = 0;
    S.recStartAt = now() - S.sessionMs;
    S.recording = true;
    resetGazeFilter();
    S.lastAccepted = null;
    setRecUI();
    el.stageEmpty.classList.add('hide');
    if (!fromDemo) toast('记录已开始。保持自然浏览，视线落点会实时累积。', 'ok');
  }

  function pauseRecording(silent) {
    if (!S.recording) return;
    S.sessionMs = now() - S.recStartAt;
    S.recording = false;
    resetGazeFilter();
    S.lastAccepted = null;
    setRecUI();
    if (!silent) {
      const n = getData().points.length;
      toast('已暂停，当前内容累计 ' + n + ' 个样本。');
    }
  }

  function toggleRecording() {
    if (!S.tracking) {
      toast('请先启动视线追踪，或使用演示模式。');
      return;
    }
    if (S.recording) pauseRecording(false);
    else startRecording(false);
  }

  function setRecUI() {
    el.btnRecord.disabled = !S.tracking;
    el.btnRecord.classList.toggle('on', S.recording);
    el.btnRecord.textContent = S.recording ? '暂停记录' : (S.sessionMs > 0 ? '继续记录' : '开始记录');
    el.pillRec.classList.toggle('on', S.recording);
    el.pillRec.querySelector('span').textContent = S.recording ? '记录中' : (S.sessionMs > 0 ? '已暂停' : '待记录');
    el.liveBadge.classList.toggle('on', S.recording);
    el.liveTime.textContent = fmtTime(S.recording ? now() - S.recStartAt : S.sessionMs);
    el.cursor.classList.toggle('rec', S.recording);
  }

  /* ============================================================
     头部就位引导
     ============================================================ */
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function guideReset() {
    S.guide.results = null;
    S.guide.history = [];
    S.guide.stableSince = 0;
    S.guide.ready = false;
    S.guide.meshFailed = false;
    el.guideBox.className = 'guide-box';
    el.guideBox.style.transform = 'none';
    el.guideBoxLabel.textContent = '寻找人脸…';
    el.guideLoading.classList.remove('hide');
    el.guideLoading.innerHTML = '<i></i><span>正在加载人脸模型…</span>';
    el.guideHint.textContent = '请正对屏幕，保持自然坐姿。';
    el.btnGuideStart.disabled = true;
    el.btnGuideStart.textContent = '请先完成检查';
    const skip = document.getElementById('btnGuideSkip');
    if (skip) skip.style.display = '';
    ['face', 'distance', 'center', 'pose', 'steady'].forEach((name) => setGuideCheck(name, '', '—'));
  }

  function setGuideCheck(name, state, mark) {
    const row = el.guideChecks.querySelector('[data-check="' + name + '"]');
    if (!row) return;
    row.classList.remove('ok', 'warn', 'bad');
    if (state) row.classList.add(state);
    const em = row.querySelector('em');
    if (em) em.textContent = mark;
  }

  function guideChecks(checks) {
    const has = !!checks.face;
    setGuideCheck('face', has ? 'ok' : 'bad', has ? '✓' : '×');
    setGuideCheck('distance', !has ? '' : checks.distance ? 'ok' : 'warn', !has ? '—' : checks.distance ? '✓' : '!');
    setGuideCheck('center', !has ? '' : checks.center ? 'ok' : 'warn', !has ? '—' : checks.center ? '✓' : '!');
    setGuideCheck('pose', !has ? '' : checks.pose ? 'ok' : 'warn', !has ? '—' : checks.pose ? '✓' : '!');
    setGuideCheck('steady', !has ? '' : checks.steady ? 'ok' : 'warn', !has ? '—' : checks.steady ? '✓' : '…');
  }

  async function openGuide() {
    if (S.engine !== 'webgazer') {
      toast('头部就位和标定只对真实摄像头追踪可用；演示模式无需标定。', 'err');
      return;
    }
    if (S.guide.open || S.calibrating) return;
    S.guide.open = true;
    S.resumeAfterGuide = S.recording;
    if (S.recording) pauseRecording(true);
    // 引导期间不暂停 WebGazer：让它和 MediaPipe 并行预热，
    // 否则引导结束后还要等 TF facemesh 冷启动，标定容易采不到样本。
    guideReset();
    el.guideOverlay.classList.add('show');
    el.guideOverlay.setAttribute('aria-hidden', 'false');
    const session = ++S.guide.session;
    const videoOk = await setupGuideVideo(session);
    if (session !== S.guide.session || !S.guide.open) return;
    if (!videoOk) return;
    await setupGuideMesh(session);
    if (session !== S.guide.session || !S.guide.open || S.guide.meshFailed) return;
    startGuideLoop(session);
  }

  async function setupGuideVideo(session) {
    const wgVideo = document.getElementById('webgazerVideoFeed');
    let stream = null;
    for (let i = 0; i < 20; i++) {
      if (session !== S.guide.session) return;
      if (wgVideo && wgVideo.srcObject) { stream = wgVideo.srcObject; S.guide.shared = true; break; }
      await wait(150);
    }
    if (!stream) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
          audio: false,
        });
        S.guide.shared = false;
        S.guide.stream = stream;
      } catch (err) {
        console.error('[guide] camera unavailable', err);
        guideMeshUnavailable('无法读取摄像头画面，可以跳过检查直接标定。');
        return false;
      }
    }
    el.guideVideo.srcObject = stream;
    try { await el.guideVideo.play(); } catch (err) { /* noop */ }
    return true;
  }

  function hasWebGL() {
    try {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
      return !!gl;
    } catch (err) {
      return false;
    }
  }

  function guideMeshUnavailable(message) {
    S.guide.meshFailed = true;
    if (S.guide.mesh) {
      try { S.guide.mesh.close(); } catch (err) { /* noop */ }
      S.guide.mesh = null;
    }
    el.guideLoading.classList.remove('hide');
    el.guideLoading.innerHTML = '<span>' + message + '</span>';
    el.guideBox.classList.remove('on', 'warn');
    el.guideHint.textContent = message;
    el.btnGuideStart.disabled = false;
    el.btnGuideStart.textContent = '跳过检查，开始标定';
    const skip = document.getElementById('btnGuideSkip');
    if (skip) skip.style.display = 'none';
    S.guide.ready = false;
  }

  async function setupGuideMesh(session) {
    S.guide.meshFailed = false;
    if (!window.FaceMesh) {
      guideMeshUnavailable('人脸模型未加载，可以跳过检查直接标定。');
      return;
    }
    if (!hasWebGL()) {
      guideMeshUnavailable('当前浏览器不支持 WebGL，人脸检测不可用；可以跳过检查直接标定。');
      return;
    }
    try {
      const mesh = new window.FaceMesh({
        locateFile: (file) => 'vendor/mediapipe/face_mesh/' + file + '?v=20261105b',
      });
      mesh.setOptions({
        maxNumFaces: 1,
        refineLandmarks: false,
        minDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
      mesh.onResults((results) => {
        S.guide.results = results;
        el.guideLoading.classList.add('hide');
      });
      if (mesh.initialize) await mesh.initialize();
      if (session !== S.guide.session || !S.guide.open) {
        try { mesh.close(); } catch (err) { /* noop */ }
        return;
      }
      S.guide.mesh = mesh;
      el.guideLoading.innerHTML = '<i></i><span>正在启动人脸检测…</span>';
    } catch (err) {
      console.error('[guide] FaceMesh init failed', err);
      const msg = String((err && err.message) || err || '').slice(0, 80);
      guideMeshUnavailable('人脸模型加载失败' + (msg ? '（' + msg + '）' : '') + '，可以跳过检查直接标定。');
    }
  }

  function startGuideLoop(session) {
    let failures = 0;
    const tick = async () => {
      if (!S.guide.open || session !== S.guide.session || !S.guide.mesh) return;
      const video = el.guideVideo;
      if (video.readyState < 2 || !video.videoWidth) {
        setTimeout(tick, 120);
        return;
      }
      try {
        await S.guide.mesh.send({ image: video });
        failures = 0;
      } catch (err) {
        failures++;
        console.warn('[guide] FaceMesh send failed (' + failures + ')', err);
        if (failures >= 5) {
          const msg = String((err && err.message) || err || '').slice(0, 80);
          guideMeshUnavailable('人脸检测启动失败' + (msg ? '（' + msg + '）' : '') + '，可以跳过检查直接标定。');
          return;
        }
        await wait(400);
      }
      analyzeGuide();
      setTimeout(tick, 90);
    };
    tick();
  }

  function analyzeGuide() {
    if (!S.guide.mesh) return;
    const results = S.guide.results;
    const landmarks = results && results.multiFaceLandmarks && results.multiFaceLandmarks[0];
    if (!landmarks || !landmarks.length) {
      S.guide.history = [];
      S.guide.stableSince = 0;
      S.guide.ready = false;
      el.guideBox.classList.remove('on', 'warn');
      el.guideBoxLabel.textContent = '寻找人脸…';
      el.guideHint.textContent = '把整张脸放进画面中央，确认摄像头没有被遮挡。';
      el.btnGuideStart.disabled = true;
      el.btnGuideStart.textContent = '请先完成检查';
      guideChecks({ face: false });
      return;
    }

    let minX = 1, minY = 1, maxX = 0, maxY = 0;
    for (let i = 0; i < landmarks.length; i++) {
      const p = landmarks[i];
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    const faceW = Math.max(0.001, maxX - minX);
    const faceH = Math.max(0.001, maxY - minY);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;

    const leftEye = landmarks[33];
    const rightEye = landmarks[263];
    const nose = landmarks[1];
    const eyeMidX = (leftEye.x + rightEye.x) / 2;
    const eyeMidY = (leftEye.y + rightEye.y) / 2;
    const eyeDist = Math.max(0.06, Math.abs(rightEye.x - leftEye.x));
    const yaw = (nose.x - eyeMidX) / eyeDist;
    const pitch = (nose.y - eyeMidY) / Math.max(0.12, faceH);
    const roll = Math.atan2(rightEye.y - leftEye.y, rightEye.x - leftEye.x) * 180 / Math.PI;

    const distanceOk = faceH >= 0.34 && faceH <= 0.74;
    const centerOk = Math.abs(cx - 0.5) <= 0.13 && Math.abs(cy - 0.5) <= 0.16;
    const poseOk = Math.abs(roll) <= 8 && Math.abs(yaw) <= 0.22 && pitch >= 0.14 && pitch <= 0.50;

    S.guide.history.push({ cx, cy, faceH, t: now() });
    if (S.guide.history.length > 10) S.guide.history.shift();
    let steadyNow = false;
    if (S.guide.history.length >= 6) {
      const h = S.guide.history;
      const spreadX = Math.max.apply(null, h.map((p) => p.cx)) - Math.min.apply(null, h.map((p) => p.cx));
      const spreadY = Math.max.apply(null, h.map((p) => p.cy)) - Math.min.apply(null, h.map((p) => p.cy));
      const spreadH = Math.max.apply(null, h.map((p) => p.faceH)) - Math.min.apply(null, h.map((p) => p.faceH));
      steadyNow = spreadX < 0.02 && spreadY < 0.025 && spreadH < 0.035;
    }
    if (!steadyNow) S.guide.stableSince = 0;
    else if (!S.guide.stableSince) S.guide.stableSince = now();
    const steadyOk = steadyNow && S.guide.stableSince && (now() - S.guide.stableSince) >= 900;

    const checks = { face: true, distance: distanceOk, center: centerOk, pose: poseOk, steady: steadyOk };
    guideChecks(checks);

    // 预览画面是镜像的，所以 left 用 1 - maxX
    const bx = Math.min(1, Math.max(0, 1 - maxX));
    const by = Math.min(1, Math.max(0, minY));
    el.guideBox.style.transform = 'none';
    el.guideBox.style.left = (bx * 100).toFixed(2) + '%';
    el.guideBox.style.top = (by * 100).toFixed(2) + '%';
    el.guideBox.style.width = (Math.min(1, faceW) * 100).toFixed(2) + '%';
    el.guideBox.style.height = (Math.min(1, faceH) * 100).toFixed(2) + '%';
    el.guideBox.classList.add('on');
    const positionOk = distanceOk && centerOk && poseOk;
    el.guideBox.classList.toggle('warn', !positionOk);
    el.guideBoxLabel.textContent = positionOk ? (steadyOk ? '就位完成' : '保持不动…') : '调整到绿色框内';

    let hint = '就位完成，可以开始 9 点标定。';
    if (!distanceOk) hint = faceH < 0.34 ? '再靠近摄像头一点，让脸占画面更大一些。' : '稍微离远一点，避免脸部超出画面。';
    else if (!centerOk) hint = '请把脸移到画面中央，不要偏到边缘。';
    else if (!poseOk) hint = '保持平视，不要明显仰头、低头或歪头。';
    else if (!steadyOk) hint = '很好，保持头部不动约 1 秒…';
    el.guideHint.textContent = hint;

    const ready = checks.face && checks.distance && checks.center && checks.pose && checks.steady;
    S.guide.ready = ready;
    el.btnGuideStart.disabled = !ready;
    el.btnGuideStart.textContent = ready ? '开始 9 点标定' : '请先完成检查';
  }

  function stopGuide() {
    S.guide.open = false;
    S.guide.session++;
    el.guideOverlay.classList.remove('show');
    el.guideOverlay.setAttribute('aria-hidden', 'true');
    if (S.guide.mesh) {
      try { S.guide.mesh.close(); } catch (err) { /* noop */ }
      S.guide.mesh = null;
    }
    if (S.guide.stream) {
      S.guide.stream.getTracks().forEach((track) => track.stop());
      S.guide.stream = null;
    }
    try { el.guideVideo.pause(); } catch (err) { /* noop */ }
    el.guideVideo.srcObject = null;
    S.guide.results = null;
    S.guide.history = [];
    S.guide.stableSince = 0;
    S.guide.ready = false;
    S.guide.shared = false;
    if (S.guide.pausedWg) {
      try { window.webgazer.resume(); } catch (err) { /* noop */ }
      S.guide.pausedWg = false;
    }
  }

  function cancelGuide() {
    const resume = S.resumeAfterGuide;
    S.resumeAfterGuide = false;
    stopGuide();
    if (resume) {
      setTimeout(() => {
        if (!S.recording && S.tracking) startRecording(true);
      }, 300);
    }
  }

  /* ============================================================
     9 点标定 — 覆盖全屏 + 自动多点采样
     ============================================================ */
  const CALIB_FALLBACK = [
    [0.07, 0.11], [0.50, 0.11], [0.93, 0.11],
    [0.07, 0.50], [0.50, 0.50], [0.93, 0.50],
    [0.07, 0.90], [0.50, 0.90], [0.93, 0.90],
  ];
  let calibPoints = [];
  let calibDone = 0;
  let calibRun = 0;
  let resumeAfterCalib = false;

  const VALIDATION_DEFS = [
    { nx: 0.28, ny: 0.28, name: '左上' },
    { nx: 0.72, ny: 0.28, name: '右上' },
    { nx: 0.50, ny: 0.50, name: '中心' },
    { nx: 0.28, ny: 0.72, name: '左下' },
    { nx: 0.72, ny: 0.72, name: '右下' },
  ];

  function qualityGrade(avg) {
    if (!Number.isFinite(avg)) return { key: 'none', label: '未校验', score: null };
    if (avg <= 45) return { key: 'good', label: '优秀', score: Math.round(99 - avg / 5) };
    if (avg <= 80) return { key: 'mid', label: '良好', score: Math.round(90 - ((avg - 45) / 35) * 14) };
    if (avg <= 130) return { key: 'mid', label: '一般', score: Math.round(75 - ((avg - 80) / 50) * 20) };
    return { key: 'bad', label: '较差', score: Math.max(12, Math.round(54 - (avg - 130) / 8)) };
  }

  function pointTone(err) {
    if (!Number.isFinite(err)) return 'bad';
    if (err <= 45) return 'good';
    if (err <= 80) return 'mid';
    return 'bad';
  }

  function resetQuality(text) {
    if (!el.qualityTag) return;
    el.qualityTag.className = 'tag';
    el.qualityTag.textContent = text || '未标定';
    el.calibScore.textContent = '--';
    el.calibScore.style.color = 'var(--muted)';
    el.calibGrade.textContent = text === '标定中' ? '正在采集' : '等待标定';
    el.calibSummary.textContent = text === '标定中' ? '先完成 9 点，再自动做 5 点校验' : '完成 9 点标定后自动做 5 点校验';
    el.calibAvgErr.textContent = '--';
    el.calibMaxErr.textContent = '--';
    el.calibValidFrames.textContent = '--';
    el.calibPointList.innerHTML = '<p class="quality-card-empty">' + (text === '标定中' ? '正在采集标定样本…' : '还没有校验数据。') + '</p>';
    el.calibQualityHint.textContent = '校验会测量 5 个留出点的预测落点与目标点的真实差异。';
    if (el.btnValidate) el.btnValidate.disabled = true;
  }

  function renderQuality(report) {
    if (!el.qualityTag || !report) return;
    const g = qualityGrade(report.avg);
    el.qualityTag.className = 'tag ' + g.key;
    el.qualityTag.textContent = g.label;
    el.calibScore.textContent = g.score == null ? '--' : String(g.score);
    el.calibScore.style.color = g.key === 'good' ? 'var(--mint)' : g.key === 'mid' ? 'var(--amber)' : g.key === 'bad' ? 'var(--rose)' : 'var(--muted)';
    el.calibGrade.textContent = g.label;
    el.calibSummary.textContent = report.valid
      ? '预计误差 ' + Math.round(report.avg) + 'px · 约 ' + report.pct.toFixed(1) + '% 舞台宽'
      : '没有足够的有效校验帧';
    el.calibAvgErr.textContent = report.valid ? Math.round(report.avg) + 'px' : '--';
    el.calibMaxErr.textContent = report.valid ? Math.round(report.max) + 'px' : '--';
    el.calibValidFrames.textContent = report.frames ? String(report.frames) : '--';
    el.calibPointList.innerHTML = report.results.map((r) => {
      const tone = pointTone(r.err);
      return '<div class="q-point ' + tone + '"><i></i><span>' + r.name + '</span><b>' +
        (r.valid ? Math.round(r.err) + 'px' : '无效') + '</b></div>';
    }).join('');
    el.calibQualityHint.textContent = report.valid
      ? '≤45px 优秀 · ≤80px 良好 · ≤130px 一般；头位容差：倾斜 ±5° / 转头 ±7° / 俯仰 ±8°。'
      : '请保持头部在标定位置，重新做一次校验。';
    if (el.btnValidate) el.btnValidate.disabled = false;
  }

  function reportAdvice(key) {
    if (key === 'none') return '没有足够的有效校验帧。请保持头部在标定位置，再做一次校验。';
    if (key === 'good') return '标定质量良好。可以直接开始记录；保持当前坐姿、距离和头部位置。';
    if (key === 'mid') return '标定可用，但边缘区域可能有偏差。建议正式记录前再校验一次，或重新标定。';
    return '误差较大。建议重标：坐正、正对屏幕、距离约 55–70cm，标定时只移动眼睛，不要转头或前后移动。';
  }

  function showReport(report) {
    S.calibReport = report;
    const g = qualityGrade(report.avg);
    el.reportScore.textContent = g.score == null ? '--' : String(g.score);
    el.reportScore.style.color = g.key === 'good' ? 'var(--mint)' : g.key === 'mid' ? 'var(--amber)' : g.key === 'bad' ? 'var(--rose)' : 'var(--muted)';
    el.reportGrade.textContent = g.label;
    el.reportSummary.textContent = report.valid
      ? '5 个留出点中 ' + report.validCount + ' 个有效；预计落点误差约 ' + Math.round(report.avg) +
        'px，约为舞台宽度的 ' + report.pct.toFixed(1) + '%。'
      : '有效校验帧不足，暂时无法给出可靠误差。';
    el.reportAvg.textContent = report.valid ? Math.round(report.avg) + 'px' : '--';
    el.reportMax.textContent = report.valid ? Math.round(report.max) + 'px' : '--';
    el.reportStability.textContent = report.valid ? Math.round(report.stability) + 'px' : '--';
    el.reportFrames.textContent = report.frames ? String(report.frames) : '--';
    el.reportPoints.innerHTML = report.results.map((r) => {
      const tone = pointTone(r.err);
      return '<div class="report-point ' + tone + '"><i></i><span>' + r.name + '</span><b>' +
        (r.valid ? Math.round(r.err) + 'px' : '--') + '</b><small>' +
        (r.valid ? r.frames + ' 帧 · ±' + Math.round(r.stability) + 'px' : r.note) +
        '</small></div>';
    }).join('');
    let note = reportAdvice(g.key);
    if (report.headOff > 0) note += ' 校验中有 ' + report.headOff + ' 帧因头位偏离被跳过。';
    if (report.calibFrames < 18) note += ' 本次标定只有 ' + report.calibFrames + ' 帧有效样本，建议重标。';
    el.reportNote.className = 'report-note' + (g.key === 'bad' ? ' bad' : g.key === 'mid' || g.key === 'none' ? ' warn' : '');
    el.reportNote.textContent = note;
    el.reportOverlay.classList.add('show');
    el.reportOverlay.setAttribute('aria-hidden', 'false');
  }

  function closeReport(resume) {
    el.reportOverlay.classList.remove('show');
    el.reportOverlay.setAttribute('aria-hidden', 'true');
    const pending = resume && S.pendingResume;
    S.pendingResume = false;
    if (pending) {
      setTimeout(() => {
        if (!S.recording && S.tracking) startRecording(true);
      }, 500);
    }
  }

  function setCalibMode(mode) {
    const box = $('.calib-bar-title');
    const eyebrow = box && box.querySelector('.eyebrow');
    const title = box && box.querySelector('strong');
    if (eyebrow) eyebrow.textContent = mode === 'validation' ? 'ACCURACY · 5 POINTS' : 'CALIBRATION · 9 POINTS';
    if (title) title.textContent = mode === 'validation' ? '看校验点，测量真实误差' : '注视靶点，保持头部不动';
    if (el.calibTotal) el.calibTotal.textContent = mode === 'validation' ? '/ 5' : '/ 9';
    if (el.calibNote) el.calibNote.textContent = mode === 'validation'
      ? '每个点约 1.2 秒，只统计头位对齐的预测点 · 结果不会写入热力图'
      : '每个点注视约 1 秒，系统自动采样 · 标定数据仅用于本机视线回归';
    const skip = $('#btnSkipCalib');
    if (skip) skip.textContent = mode === 'validation' ? '跳过校验' : '跳过标定';
  }

  function validateTargets() {
    const r = S.stageRect;
    if (!r || r.width < 100 || r.height < 100) {
      return VALIDATION_DEFS.map((d) => ({
        ...d,
        x: window.innerWidth * d.nx,
        y: window.innerHeight * (0.35 + d.ny * 0.5),
        sx: d.nx * STAGE_W,
        sy: d.ny * STAGE_H,
      }));
    }
    return VALIDATION_DEFS.map((d) => ({
      ...d,
      x: r.left + r.width * d.nx,
      y: r.top + r.height * d.ny,
      sx: d.nx * STAGE_W,
      sy: d.ny * STAGE_H,
    }));
  }

  /**
   * 标定点必须落在文章舞台内，而不是整个浏览器窗口。
   * 记录阶段只接受舞台内的样本，两者的坐标范围必须一致。
   */
  function calibTargets() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const r = S.stageRect;
    if (!r || r.width < 220 || r.height < 170) {
      return CALIB_FALLBACK.map((p) => [p[0] * w, p[1] * h]);
    }
    const left = Math.max(30, r.left + r.width * 0.07);
    const right = Math.min(w - 30, r.left + r.width * 0.93);
    const top = Math.max(84, r.top + r.height * 0.10);
    const bottom = Math.min(h - 76, r.top + r.height * 0.90);
    const xs = [left, (left + right) / 2, right];
    const ys = [top, (top + bottom) / 2, bottom];
    return ys.flatMap((y) => xs.map((x) => [x, y]));
  }

  function drawCalibArea() {
    if (!el.calibArea) return;
    const r = S.stageRect;
    if (!r || r.width < 40 || r.height < 40) {
      el.calibArea.classList.remove('show');
      return;
    }
    const w = window.innerWidth;
    const h = window.innerHeight;
    const left = Math.max(4, r.left);
    const top = Math.max(4, r.top);
    const right = Math.min(w - 4, r.right);
    const bottom = Math.min(h - 4, r.bottom);
    if (right - left < 40 || bottom - top < 40) {
      el.calibArea.classList.remove('show');
      return;
    }
    el.calibArea.style.left = left + 'px';
    el.calibArea.style.top = top + 'px';
    el.calibArea.style.width = (right - left) + 'px';
    el.calibArea.style.height = (bottom - top) + 'px';
    el.calibArea.classList.add('show');
  }

  function setCalibStatus(text) {
    if (el.calibStatus) el.calibStatus.textContent = text;
  }

  function openCalibration() {
    if (S.engine !== 'webgazer') {
      toast('标定只对真实摄像头追踪可用；演示模式无需标定。', 'err');
      return;
    }
    S.calibrating = true;
    S.validating = false;
    S.calibStale = false;
    S.headRef = null;
    S.validationResults = [];
    S.calibReport = null;
    S.pendingResume = false;
    el.btnCalib.classList.remove('stale');
    resumeAfterCalib = S.recording || S.resumeAfterGuide;
    S.resumeAfterGuide = false;
    if (S.recording) pauseRecording(true);
    calibDone = 0;
    S.calibFrames = 0;
    resetGazeFilter();
    S.lastAccepted = null;
    setCalibMode('calibration');
    resetQuality('标定中');
    el.calibCount.textContent = '0';
    $$('.calib-dot', el.calibStage).forEach((d) => d.remove());
    calibPoints = calibTargets();
    drawCalibArea();
    calibPoints.forEach((pt, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'calib-dot';
      b.style.left = pt[0] + 'px';
      b.style.top = pt[1] + 'px';
      b.innerHTML = '<span class="prog"></span><span class="num">' + (i + 1) + '</span><span class="calib-frames"></span>';
      el.calibStage.appendChild(b);
    });
    el.calibOverlay.classList.add('show');
    el.calibOverlay.setAttribute('aria-hidden', 'false');
    setCalibStatus('准备开始，请把视线放到第 1 个点…');
    const run = ++calibRun;
    runCalibration(run);
  }

  async function animateCalib(dot, ms, run) {
    const prog = dot.querySelector('.prog');
    const started = now();
    while (now() - started < ms) {
      if (run !== calibRun) return;
      const p = Math.min(100, ((now() - started) / ms) * 100);
      if (prog) prog.style.setProperty('--p', p.toFixed(1));
      await wait(45);
    }
    if (prog) prog.style.setProperty('--p', '100');
  }

  async function sampleCalibPoint(dot, run) {
    const rect = dot.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const prog = dot.querySelector('.prog');
    const started = now();
    const duration = 1000;
    let extra = 0;
    let frames = 0;
    while (now() - started < duration + extra) {
      if (run !== calibRun) break;
      const p = Math.min(100, ((now() - started) / (duration + extra)) * 100);
      if (prog) prog.style.setProperty('--p', p.toFixed(1));
      const head = readHead();
      const usable = !!head && head.ok && head.refOk;
      if (usable) {
        try {
          window.webgazer.recordScreenPosition(cx, cy, 'click');
          frames++;
          S.calibFrames++;
        } catch (err) { /* noop */ }
        if (head) {
          setCalibStatus('第 ' + (calibDone + 1) + ' 点 · 倾 ' + head.roll.toFixed(1) +
            '° · 转 ' + head.yaw.toFixed(1) + '° · 采样中…');
        }
      } else if (head && S.headRef && !head.refOk) {
        setCalibStatus('第 ' + (calibDone + 1) + ' 点 · 头位偏了，请回正');
      }
      if (now() - started >= duration + extra && frames < 6 && extra < 900) {
        extra += 450;
      }
      await wait(90);
    }
    if (prog) prog.style.setProperty('--p', '100');
    return frames;
  }

  async function captureHeadRef(run) {
    const samples = [];
    for (let i = 0; i < 6; i++) {
      if (run !== calibRun) return false;
      const h = readHead();
      if (h && !h.blink) samples.push(h);
      await wait(120);
    }
    if (samples.length < 3) return false;
    const avg = samples.reduce((a, h) => {
      a.cx += h.cx; a.cy += h.cy; a.faceW += h.faceW; a.faceH += h.faceH;
      a.roll += h.roll; a.yaw += h.yaw; a.pitch += h.pitch;
      return a;
    }, { cx: 0, cy: 0, faceW: 0, faceH: 0, roll: 0, yaw: 0, pitch: 0 });
    const n = samples.length;
    Object.keys(avg).forEach((k) => { avg[k] /= n; });
    S.headRef = {
      cx: avg.cx, cy: avg.cy, faceW: avg.faceW, faceH: avg.faceH,
      roll: avg.roll, yaw: avg.yaw, pitch: avg.pitch,
      box: { x: avg.cx - avg.faceW / 2, y: avg.cy - avg.faceH / 2, w: avg.faceW, h: avg.faceH },
    };
    return true;
  }

  async function waitForEyes(run) {
    setCalibStatus('正在等待视线模型检测到眼睛…');
    const started = now();
    while (now() - started < 10000) {
      if (run !== calibRun) return false;
      if (readHead()) return true;
      await wait(250);
    }
    return false;
  }

  async function runCalibration(run) {
    await wait(650);
    if (!(await waitForEyes(run))) {
      if (run !== calibRun) return;
      finishCalibration(true);
      toast('没有检测到眼睛，无法采样。请确认摄像头画面中能看到整张脸，等小窗显示「头部稳定」后再重新标定。', 'err');
      return;
    }
    if (!(await captureHeadRef(run))) {
      if (run !== calibRun) return;
      finishCalibration(true);
      toast('无法记录头部参考位置，请保持脸部在画面中再试。', 'err');
      return;
    }
    const dots = $$('.calib-dot', el.calibStage);
    for (let i = 0; i < calibPoints.length; i++) {
      if (run !== calibRun) return;
      const dot = dots[i];
      if (!dot) return;
      dots.forEach((d) => d.classList.remove('active'));
      dot.classList.add('active');
      setCalibStatus('第 ' + (i + 1) + ' 点 · 注视靶点，保持不动');
      await animateCalib(dot, 650, run);
      if (run !== calibRun) return;
      dot.classList.add('sampling');
      setCalibStatus('第 ' + (i + 1) + ' 点 · 正在采样…');
      const frames = await sampleCalibPoint(dot, run);
      if (run !== calibRun) return;
      if (i === 0 && frames === 0) {
        finishCalibration(true);
        toast('没有采到有效样本，标定已中止。请让脸部保持在画面中，等小窗显示「头部稳定」后再试。', 'err');
        return;
      }
      dot.classList.remove('sampling');
      dot.classList.add('done');
      const frameEl = dot.querySelector('.calib-frames');
      if (frameEl) frameEl.textContent = frames + ' 帧';
      calibDone++;
      el.calibCount.textContent = String(calibDone);
      setCalibStatus('第 ' + (i + 1) + ' 点完成');
      await wait(240);
    }
    if (run === calibRun) finishCalibration(false);
  }

  function finishCalibration(skipped) {
    calibRun++;
    const frames = S.calibFrames;
    if (skipped) {
      el.calibOverlay.classList.remove('show');
      el.calibOverlay.setAttribute('aria-hidden', 'true');
      S.calibrating = false;
      S.validating = false;
      S.calibView = null;
      S.pendingResume = false;
      resetGazeFilter();
      S.lastAccepted = null;
      resetQuality('未标定');
      const resume = resumeAfterCalib;
      resumeAfterCalib = false;
      if (resume) {
        setTimeout(() => {
          if (!S.recording && S.tracking) startRecording(true);
        }, 600);
      }
      toast('已跳过标定。可以随时点击「9 点标定」重新开始。');
      return;
    }
    S.calibView = { w: window.innerWidth, h: window.innerHeight };
    S.calibrating = true;
    el.qualityTag.className = 'tag';
    el.qualityTag.textContent = '校验中';
    el.calibScore.textContent = '--';
    el.calibGrade.textContent = '正在准备校验';
    el.calibSummary.textContent = '9 点已完成，接下来用 5 个留出点测误差';
    el.calibAvgErr.textContent = '--';
    el.calibMaxErr.textContent = '--';
    el.calibValidFrames.textContent = String(frames);
    el.calibPointList.innerHTML = '<p class="quality-card-empty">正在准备 5 点校验…</p>';
    el.calibQualityHint.textContent = '校验会测量 5 个留出点的预测落点与目标点的真实差异。';
    if (el.btnValidate) el.btnValidate.disabled = true;
    toast(frames < 18
      ? '9 点完成，但有效样本偏少（' + frames + ' 帧）。继续做 5 点校验看真实误差。'
      : '9 点完成：共 ' + frames + ' 帧。接下来做 5 点校验，测真实误差。', frames < 18 ? 'warn' : 'ok');
    setTimeout(() => {
      if (S.calibrating && S.engine === 'webgazer' && S.tracking) startValidation();
    }, 500);
  }

  function startValidation() {
    if (S.engine !== 'webgazer' || !S.tracking) {
      toast('校验需要先启动摄像头追踪。', 'err');
      return;
    }
    if (!S.headRef) {
      toast('还没有头部基准，请先完成 9 点标定。', 'err');
      return;
    }
    if (S.validating) return;
    const wasRecording = S.recording;
    if (wasRecording) pauseRecording(true);
    S.pendingResume = S.pendingResume || wasRecording || resumeAfterCalib;
    resumeAfterCalib = false;
    S.validating = true;
    S.calibrating = true;
    S.calibStale = false;
    S.validationResults = [];
    calibDone = 0;
    resetGazeFilter();
    S.lastAccepted = null;
    setCalibMode('validation');
    el.calibCount.textContent = '0';
    $$('.calib-dot', el.calibStage).forEach((d) => d.remove());
    const targets = validateTargets();
    targets.forEach((pt, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'calib-dot val';
      b.style.left = pt.x + 'px';
      b.style.top = pt.y + 'px';
      b.innerHTML = '<span class="prog"></span><span class="num">' + (i + 1) + '</span><span class="calib-frames"></span>';
      el.calibStage.appendChild(b);
    });
    drawCalibArea();
    el.calibOverlay.classList.add('show');
    el.calibOverlay.setAttribute('aria-hidden', 'false');
    el.qualityTag.className = 'tag';
    el.qualityTag.textContent = '校验中';
    el.calibScore.textContent = '--';
    el.calibGrade.textContent = '正在测量';
    el.calibSummary.textContent = '5 个留出点 · 只统计头位对齐的帧';
    el.calibAvgErr.textContent = '--';
    el.calibMaxErr.textContent = '--';
    el.calibValidFrames.textContent = '0';
    el.calibPointList.innerHTML = '<p class="quality-card-empty">正在采集校验样本…</p>';
    el.calibQualityHint.textContent = '误差 = 预测落点均值与靶点的距离，按舞台坐标计算。';
    if (el.btnValidate) el.btnValidate.disabled = true;
    setCalibStatus('校验点 1 · 注视靶点，保持头部不动');
    const run = ++calibRun;
    runValidation(run);
  }

  async function sampleValidationPoint(dot, pt, index, run) {
    const prog = dot.querySelector('.prog');
    const started = now();
    const duration = 1200;
    let extra = 0;
    const samples = [];
    let headOff = 0;
    let outside = 0;
    while (now() - started < duration + extra) {
      if (run !== calibRun) break;
      const elapsed = now() - started;
      const p = Math.min(100, (elapsed / (duration + extra)) * 100);
      if (prog) prog.style.setProperty('--p', p.toFixed(1));
      const head = readHead();
      const fresh = S.gaze.live && now() - S.gaze.ts < 320;
      const headReady = !!head && head.ok && (!S.headRef || head.refOk) && !head.blink;
      if (fresh && headReady) {
        const stage = clientToStage(S.gaze.x, S.gaze.y);
        if (stage && stage.x >= -8 && stage.y >= -8 && stage.x <= STAGE_W + 8 && stage.y <= STAGE_H + 8) {
          samples.push({ x: stage.x, y: stage.y });
        } else {
          outside++;
        }
      } else if (head && (!head.ok || (S.headRef && !head.refOk))) {
        headOff++;
      }
      if (head && S.headRef && !head.refOk) {
        setCalibStatus('校验点 ' + (index + 1) + '/5 · 头位偏了，请回正');
      } else if (head && head.ok) {
        setCalibStatus('校验点 ' + (index + 1) + '/5 · 倾 ' + head.roll.toFixed(1) +
          '° · 转 ' + head.yaw.toFixed(1) + '° · 测量中…');
      }
      if (elapsed >= duration + extra && samples.length < 6 && extra < 1200) extra += 400;
      await wait(80);
    }
    if (prog) prog.style.setProperty('--p', '100');
    let mx = 0, my = 0;
    if (samples.length) {
      mx = samples.reduce((a, s) => a + s.x, 0) / samples.length;
      my = samples.reduce((a, s) => a + s.y, 0) / samples.length;
    }
    const err = samples.length ? Math.hypot(mx - pt.sx, my - pt.sy) : NaN;
    const stability = samples.length
      ? Math.sqrt(samples.reduce((a, s) => a + (s.x - mx) ** 2 + (s.y - my) ** 2, 0) / samples.length)
      : NaN;
    return {
      name: pt.name,
      err,
      stability,
      frames: samples.length,
      headOff,
      outside,
      valid: samples.length >= 4,
      note: samples.length >= 4 ? '' : headOff > outside ? '头位偏离' : '样本不足',
    };
  }

  async function runValidation(run) {
    const targets = validateTargets();
    const dots = $$('.calib-dot.val', el.calibStage);
    const results = [];
    for (let i = 0; i < targets.length; i++) {
      if (run !== calibRun) return;
      const dot = dots[i];
      if (!dot) return;
      dots.forEach((d) => d.classList.remove('active'));
      dot.classList.add('active');
      setCalibStatus('校验点 ' + (i + 1) + '/5 · 注视靶点，保持不动');
      await animateCalib(dot, 420, run);
      if (run !== calibRun) return;
      dot.classList.add('sampling');
      const result = await sampleValidationPoint(dot, targets[i], i, run);
      if (run !== calibRun) return;
      results.push(result);
      dot.classList.remove('sampling');
      dot.classList.add('done');
      if (result.valid) dot.classList.add(pointTone(result.err));
      const frameEl = dot.querySelector('.calib-frames');
      if (frameEl) frameEl.textContent = result.valid ? Math.round(result.err) + ' px' : '无效';
      calibDone++;
      el.calibCount.textContent = String(calibDone);
      setCalibStatus(result.valid
        ? '校验点 ' + (i + 1) + '/5 · 误差 ' + Math.round(result.err) + 'px'
        : '校验点 ' + (i + 1) + '/5 · 未采到有效样本');
      await wait(240);
    }
    S.validationResults = results;
    if (run === calibRun) finishValidation(false);
  }

  function finishValidation(skipped) {
    calibRun++;
    S.validating = false;
    S.calibrating = false;
    el.calibOverlay.classList.remove('show');
    el.calibOverlay.setAttribute('aria-hidden', 'true');
    resetGazeFilter();
    S.lastAccepted = null;
    const results = S.validationResults || [];
    const valid = results.filter((r) => r.valid);
    if (skipped) {
      el.qualityTag.className = 'tag';
      el.qualityTag.textContent = '待校验';
      el.calibScore.textContent = '--';
      el.calibGrade.textContent = '未校验';
      el.calibSummary.textContent = '9 点已完成，但还没有测误差';
      el.calibAvgErr.textContent = '--';
      el.calibMaxErr.textContent = '--';
      el.calibValidFrames.textContent = String(S.calibFrames || '--');
      el.calibPointList.innerHTML = '<p class="quality-card-empty">点击「校验准确度」测量落点误差。</p>';
      el.calibQualityHint.textContent = '建议做一次 5 点校验，确认标定是否可用。';
      if (el.btnValidate) el.btnValidate.disabled = false;
      toast('已跳过校验。可以随时点击「校验准确度」补做。');
      const pending = S.pendingResume;
      S.pendingResume = false;
      if (pending) {
        setTimeout(() => {
          if (!S.recording && S.tracking) startRecording(true);
        }, 500);
      }
      return;
    }
    const avg = valid.length ? valid.reduce((a, r) => a + r.err, 0) / valid.length : NaN;
    const max = valid.length ? Math.max(...valid.map((r) => r.err)) : NaN;
    const stability = valid.length ? valid.reduce((a, r) => a + r.stability, 0) / valid.length : NaN;
    const frames = results.reduce((a, r) => a + r.frames, 0);
    const headOff = results.reduce((a, r) => a + r.headOff, 0);
    const report = {
      avg,
      max,
      stability,
      frames,
      headOff,
      results,
      valid: valid.length > 0,
      validCount: valid.length,
      calibFrames: S.calibFrames,
      pct: valid.length ? (avg / STAGE_W) * 100 : 0,
    };
    renderQuality(report);
    showReport(report);
    if (report.valid) {
      toast('校验完成：预计误差约 ' + Math.round(avg) + 'px（舞台宽 ' + report.pct.toFixed(1) + '%）。',
        avg <= 80 ? 'ok' : 'warn');
    } else {
      toast('校验没有采到足够的有效样本。请保持头位，再做一次校验。', 'warn');
    }
  }

  /* ============================================================
     统计面板
     ============================================================ */
  let lastAoiHtml = '';
  function updateStats(force) {
    const d = getData();
    const n = d.points.length;
    el.statPoints.textContent = n.toLocaleString('zh-CN');
    const dur = n > 1 ? (d.points[n - 1].t - d.points[0].t) / 1000 : 0;
    el.statDuration.innerHTML = dur.toFixed(1) + '<small>s</small>';

    const entries = Object.entries(d.counts)
      .filter(([k]) => k !== '背景')
      .sort((a, b) => b[1] - a[1]);
    el.statAoi.textContent = entries.length ? entries[0][0] : '--';

    const rate = d.allGaze ? Math.round((d.inStage / d.allGaze) * 100) : null;
    el.statHit.textContent = rate === null ? '--' : rate + '%';
    el.hitBar.style.width = (rate || 0) + '%';

    el.aoiTotal.textContent = n + ' 点';
    let html = '';
    if (!n) {
      html = '<p class="empty-line">开始记录后，这里会按注视样本占比排序。</p>';
    } else {
      const all = Object.entries(d.counts).sort((a, b) => b[1] - a[1]).slice(0, 7);
      for (const [name, count] of all) {
        const pct = Math.round((count / n) * 100);
        const bg = name === '背景';
        html += '<div class="aoi-row">' +
          '<span class="aoi-name" title="' + escapeHtml(name) + '">' + escapeHtml(name) + '</span>' +
          '<span class="aoi-val">' + pct + '%</span>' +
          '<div class="aoi-track"><i style="width:' + Math.max(2, pct) + '%;' +
          (bg ? 'background:rgba(255,255,255,.22)' : '') + '"></i></div>' +
          '</div>';
      }
    }
    if (force || html !== lastAoiHtml) {
      el.aoiList.innerHTML = html;
      lastAoiHtml = html;
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ============================================================
     视图 / 参数
     ============================================================ */
  function setView(v) {
    S.view = v;
    $$('#viewSwitch button').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
    el.heat.classList.toggle('show', v === 'heat');
    el.track.classList.toggle('show', v === 'track' || v === 'points');
    if (v === 'heat') { renderHeat(); S.heatDirty = false; }
    else if (v === 'track' || v === 'points') { renderTrack(); S.dirty = false; }
    if (v === 'track' || v === 'points') {
      const n = getData().points.length;
      if (n) toast(v === 'track' ? '轨迹视图：颜色由蓝到红表示时间推进。' : '点阵视图：每个点是一个注视样本。');
    }
  }

  let rebuildTimer = 0;
  function scheduleRebuild() {
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => {
      rebuildHeat();
      if (S.view === 'track' || S.view === 'points') renderTrack();
    }, 110);
  }

  /* ============================================================
     导出
     ============================================================ */
  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function stamp() {
    const d = new Date();
    const p = (v) => String(v).padStart(2, '0');
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
  }

  function csvCell(v) {
    const s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function exportCsv() {
    const d = getData();
    if (!d.points.length) {
      toast('当前内容还没有样本，先记录一段视线。', 'err');
      return;
    }
    const rows = [['index', 't_ms', 't_sec', 'x_stage', 'y_stage', 'x_norm', 'y_norm', 'aoi', 'content']];
    d.points.forEach((p, i) => {
      rows.push([
        i + 1,
        p.t,
        (p.t / 1000).toFixed(3),
        p.x,
        p.y,
        (p.x / STAGE_W).toFixed(5),
        (p.y / STAGE_H).toFixed(5),
        p.aoi,
        S.content,
      ]);
    });
    const text = '\uFEFF' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
    download(new Blob([text], { type: 'text/csv;charset=utf-8' }), 'sightline-' + S.content + '-' + stamp() + '.csv');
    toast('CSV 已导出：' + d.points.length + ' 行原始样本。', 'ok');
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function contentBg(id) {
    if (id === 'article') return '#f5f0e6';
    if (id === 'landing') return '#fbfbfd';
    return '#eef1f7';
  }

  async function captureContentSnapshot() {
    const css = await fetch('style.css').then((r) => (r.ok ? r.text() : ''));
    const scoped = css.replace(/:root/g, '.sightline-report-root');
    const html = '<div xmlns="http://www.w3.org/1999/xhtml" class="sightline-report-root" style="width:1280px;height:800px;overflow:hidden">' +
      '<style>' + scoped + '</style>' +
      '<style>.sightline-report-root{width:1280px;height:800px;overflow:hidden}.sightline-report-root .content{position:relative;inset:auto;width:1280px;height:800px}</style>' +
      '<div class="content">' + el.content.innerHTML + '</div></div>';
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800"><foreignObject x="0" y="0" width="1280" height="800">' + html + '</foreignObject></svg>';
    const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = 1280;
    c.height = 800;
    c.getContext('2d').drawImage(img, 0, 0, 1280, 800);
    return c;
  }

  async function exportPng() {
    const d = getData();
    if (!d.points.length) {
      toast('当前内容还没有样本，先记录一段视线。', 'err');
      return;
    }
    const W = 1440;
    const H = 880;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d');

    ctx.fillStyle = '#0a0c11';
    ctx.fillRect(0, 0, W, H);
    const grad = ctx.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, 'rgba(116,240,206,.10)');
    grad.addColorStop(0.45, 'rgba(116,240,206,0)');
    grad.addColorStop(1, 'rgba(255,98,133,.06)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = '#74f0ce';
    ctx.fillRect(48, 42, 26, 2);

    ctx.fillStyle = '#e9ecf4';
    ctx.font = '600 30px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.fillText('视线热力图报告', 48, 84);
    ctx.fillStyle = '#7d8497';
    ctx.font = '11px ui-monospace, Menlo, monospace';
    ctx.fillText('SIGHTLINE / GAZE HEATMAP REPORT', 48, 104);

    const dnow = new Date();
    const dateStr = dnow.toLocaleString('zh-CN', { hour12: false });
    ctx.textAlign = 'right';
    ctx.fillStyle = '#8b91a3';
    ctx.font = '11px ui-monospace, Menlo, monospace';
    ctx.fillText(dateStr, W - 48, 84);
    ctx.fillText('CONTENT / ' + CONTENT_DEFS[S.content].label + ' · ' + S.content.toUpperCase(), W - 48, 104);
    ctx.textAlign = 'left';

    // 热力图面板：内容快照 + 热力叠加
    const px = 48, py = 136, pw = 900, ph = 562;
    const snapshot = await captureContentSnapshot().catch(() => null);
    ctx.save();
    roundRect(ctx, px, py, pw, ph, 10);
    ctx.clip();
    if (snapshot) {
      ctx.drawImage(snapshot, px, py, pw, ph);
    } else {
      ctx.fillStyle = contentBg(S.content);
      ctx.fillRect(px, py, pw, ph);
    }
    ctx.drawImage(el.heat, px, py, pw, ph);
    ctx.restore();
    ctx.strokeStyle = 'rgba(255,255,255,.14)';
    ctx.lineWidth = 1;
    roundRect(ctx, px + .5, py + .5, pw - 1, ph - 1, 10);
    ctx.stroke();

    // 右侧统计
    const rx = 984;
    let ry = 146;
    ctx.fillStyle = '#8b91a3';
    ctx.font = '10px ui-monospace, Menlo, monospace';
    ctx.fillText('SESSION SUMMARY', rx, ry);
    ry += 14;
    ctx.fillStyle = 'rgba(255,255,255,.08)';
    ctx.fillRect(rx, ry, 408, 1);
    ry += 30;

    const n = d.points.length;
    const dur = n > 1 ? (d.points[n - 1].t - d.points[0].t) / 1000 : 0;
    const top = Object.entries(d.counts).filter(([k]) => k !== '背景').sort((a, b) => b[1] - a[1])[0];
    const rate = d.allGaze ? Math.round((d.inStage / d.allGaze) * 100) : 0;
    const stats = [
      ['注视样本', n.toLocaleString('zh-CN')],
      ['采样跨度', dur.toFixed(1) + ' s'],
      ['有效落点率', rate + ' %'],
      ['主要关注区', top ? top[0] : '--'],
    ];
    stats.forEach(([k, v]) => {
      ctx.fillStyle = '#7d8497';
      ctx.font = '11px -apple-system, "PingFang SC", sans-serif';
      ctx.fillText(k, rx, ry);
      ctx.textAlign = 'right';
      ctx.fillStyle = '#e9ecf4';
      ctx.font = '600 15px -apple-system, "PingFang SC", sans-serif';
      ctx.fillText(v, rx + 408, ry);
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(255,255,255,.06)';
      ctx.fillRect(rx, ry + 11, 408, 1);
      ry += 33;
    });

    ry += 14;
    ctx.fillStyle = '#8b91a3';
    ctx.font = '10px ui-monospace, Menlo, monospace';
    ctx.fillText('AREAS OF INTEREST', rx, ry);
    ry += 20;

    const entries = Object.entries(d.counts).sort((a, b) => b[1] - a[1]).slice(0, 7);
    entries.forEach(([name, count]) => {
      const pct = Math.round((count / n) * 100);
      ctx.fillStyle = '#c9ceda';
      ctx.font = '11px -apple-system, "PingFang SC", sans-serif';
      ctx.fillText(name, rx, ry);
      ctx.textAlign = 'right';
      ctx.fillStyle = '#8b91a3';
      ctx.font = '10px ui-monospace, Menlo, monospace';
      ctx.fillText(pct + '%', rx + 408, ry);
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(255,255,255,.07)';
      ctx.fillRect(rx, ry + 6, 408, 3);
      ctx.fillStyle = name === '背景' ? 'rgba(255,255,255,.2)' : '#74f0ce';
      ctx.fillRect(rx, ry + 6, 408 * Math.max(0.01, count / n), 3);
      ry += 25;
    });

    ry = 780;
    ctx.fillStyle = 'rgba(255,255,255,.06)';
    ctx.fillRect(rx, ry, 408, 1);
    ry += 20;
    ctx.fillStyle = '#6f7688';
    ctx.font = '10px ui-monospace, Menlo, monospace';
    ctx.fillText('HEAT RADIUS ' + S.radius + 'px   INTENSITY ' + S.intensity.toFixed(2) + 'x', rx, ry);
    ctx.fillText('ALGORITHM  GAUSSIAN KDE / 30Hz SAMPLING', rx, ry + 16);

    // 底部说明
    ctx.fillStyle = '#5f6678';
    ctx.font = '10.5px -apple-system, "PingFang SC", sans-serif';
    ctx.fillText('热力颜色越暖代表注视驻留越久；数据仅保存在本机。由 Sightline 视线热力图工作台生成。', 48, 760);
    ctx.fillStyle = 'rgba(255,255,255,.06)';
    ctx.fillRect(48, 786, 900, 1);
    ctx.fillStyle = '#8b91a3';
    ctx.font = '10px ui-monospace, Menlo, monospace';
    ctx.fillText('SAMPLES ' + n + '   DURATION ' + dur.toFixed(1) + 's   CONTENT ' + S.content, 48, 812);

    c.toBlob((blob) => {
      if (!blob) { toast('报告生成失败，请重试。', 'err'); return; }
      download(blob, 'sightline-report-' + S.content + '-' + stamp() + '.png');
      toast('报告 PNG 已导出（含热力图与 AOI 统计）。', 'ok');
    }, 'image/png');
  }

  function clearCurrent() {
    const d = getData();
    if (!d.points.length) {
      toast('当前内容还没有可清空的记录。');
      return;
    }
    S.data[S.content] = blankData();
    resetGazeFilter();
    S.lastAccepted = null;
    S.sessionMs = 0;
    if (S.recording) S.recStartAt = now();
    rebuildHeat();
    renderTrack();
    updateStats(true);
    setRecUI();
    toast('已清空「' + CONTENT_DEFS[S.content].label + '」的记录。', 'ok');
  }

  /* ============================================================
     渲染循环 / 尺寸
     ============================================================ */
  let lastStats = 0;
  let lastFrameTs = 0;
  function loop(ts) {
    requestAnimationFrame(loop);

    // FPS（每秒结算一次）
    if (ts - S.fpsCounter.last >= 1000) {
      S.fps = Math.round((S.fpsCounter.frames * 1000) / (ts - S.fpsCounter.last));
      S.fpsCounter.frames = 0;
      S.fpsCounter.last = ts;
      if (S.engine === 'webgazer') {
        el.pillFps.querySelector('span').textContent = S.fps + ' FPS';
        el.pillFps.classList.toggle('on', S.fps > 0);
      }
    }

    if (S.gaze.live && now() - S.gaze.ts > 1300) {
      S.gaze.live = false;
      el.cursor.classList.remove('live');
    }

    if (S.engine === 'webgazer' && el.miniCam.classList.contains('show')) {
      // 已经有预测后，预测中断 = 脸/眼睛离开画面，不能继续用旧关键点
      if (S.hasPrediction && now() - S.gaze.ts > 1600) {
        if (!S.miniIdle) { S.miniIdle = true; clearMiniFace(); }
      } else if (now() - S.lastHeadProbe > 300) {
        // 标定前还没有预测，仍用关键点做头部状态
        S.lastHeadProbe = now();
        const head = readHead();
        if (head) {
          S.miniIdle = false;
          updateMini(head);
        } else if (now() - S.gaze.ts > 1600 && !S.miniIdle) {
          S.miniIdle = true;
          clearMiniFace();
        }
      }
    }

    if (ts - lastFrameTs > 95) {
      lastFrameTs = ts;
      if (S.view === 'heat' && S.heatDirty) {
        renderHeat();
        S.heatDirty = false;
      } else if ((S.view === 'track' || S.view === 'points') && S.dirty) {
        renderTrack();
        S.dirty = false;
      }
    }

    if (ts - lastStats > 260) {
      lastStats = ts;
      updateStats(false);
      if (S.recording) el.liveTime.textContent = fmtTime(now() - S.recStartAt);
    }
  }

  let resizeTimer = 0;
  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      layoutStage();
      measureAoi();
      renderTrack();
      S.dirty = false;
      if (S.calibView) {
        const dw = Math.abs(window.innerWidth - S.calibView.w) / S.calibView.w;
        const dh = Math.abs(window.innerHeight - S.calibView.h) / S.calibView.h;
        if (dw > 0.04 || dh > 0.04) {
          if (!S.calibStale) {
            S.calibStale = true;
            el.btnCalib.classList.add('stale');
            toast('窗口尺寸已变化，视线映射可能偏移，建议重新做 9 点标定。', 'warn');
          }
        }
      }
    }, 120);
  }

  /* ============================================================
     事件
     ============================================================ */
  el.btnStart.addEventListener('click', startTracking);
  el.btnRecord.addEventListener('click', toggleRecording);
  el.btnCalib.addEventListener('click', openGuide);
  el.miniClose.addEventListener('click', () => {
    S.miniHidden = true;
    el.miniCam.classList.remove('show');
    el.miniOpen.classList.add('show');
  });
  el.miniOpen.addEventListener('click', () => {
    S.miniHidden = false;
    el.miniOpen.classList.remove('show');
    el.miniCam.classList.add('show');
    bindMiniStream();
  });
  el.btnDemo.addEventListener('click', enableDemo);
  el.btnCsv.addEventListener('click', exportCsv);
  el.btnPng.addEventListener('click', exportPng);
  el.btnClear.addEventListener('click', clearCurrent);
  $('#btnSkipCalib').addEventListener('click', () => {
    if (S.validating) finishValidation(true);
    else finishCalibration(true);
  });
  el.btnValidate.addEventListener('click', () => startValidation());
  el.btnReportClose.addEventListener('click', () => closeReport(true));
  el.btnReportDone.addEventListener('click', () => closeReport(true));
  el.btnReportRecal.addEventListener('click', () => {
    closeReport(false);
    setTimeout(() => openCalibration(), 120);
  });
  el.reportOverlay.addEventListener('click', (e) => {
    if (e.target === el.reportOverlay) closeReport(true);
  });
  $('#btnGuideStart').addEventListener('click', () => {
    if (!S.guide.ready && !S.guide.meshFailed) return;
    stopGuide();
    openCalibration();
  });
  $('#btnGuideSkip').addEventListener('click', () => {
    stopGuide();
    openCalibration();
  });
  $('#btnGuideClose').addEventListener('click', cancelGuide);
  $('#btnRecenter').addEventListener('click', () => { layoutStage(); measureAoi(); renderTrack(); });

  $('#btnHelp').addEventListener('click', () => {
    el.helpOverlay.classList.add('show');
    el.helpOverlay.setAttribute('aria-hidden', 'false');
  });
  const closeHelp = () => {
    el.helpOverlay.classList.remove('show');
    el.helpOverlay.setAttribute('aria-hidden', 'true');
  };
  $('#btnCloseHelp').addEventListener('click', closeHelp);
  $('#btnHelpDone').addEventListener('click', closeHelp);
  el.helpOverlay.addEventListener('click', (e) => {
    if (e.target === el.helpOverlay) closeHelp();
  });

  $('#viewSwitch').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-view]');
    if (b) setView(b.dataset.view);
  });

  $('#contentSwitch').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-content]');
    if (!b || b.dataset.content === S.content) return;
    renderContent(b.dataset.content);
    updateStats(true);
  });

  el.radius.addEventListener('input', () => {
    S.radius = Number(el.radius.value);
    el.radiusOut.textContent = S.radius + ' px';
    scheduleRebuild();
  });
  el.intensity.addEventListener('input', () => {
    S.intensity = Number(el.intensity.value);
    el.intensityOut.textContent = S.intensity.toFixed(2) + '×';
    scheduleRebuild();
  });

  document.addEventListener('keydown', (e) => {
    if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    const k = e.key.toLowerCase();
    if (k === 'escape') {
      if (el.reportOverlay.classList.contains('show')) closeReport(true);
      else if (el.guideOverlay.classList.contains('show')) cancelGuide();
      else if (el.calibOverlay.classList.contains('show')) {
        if (S.validating) finishValidation(true);
        else finishCalibration(true);
      } else if (el.helpOverlay.classList.contains('show')) closeHelp();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (k === 'r') { e.preventDefault(); toggleRecording(); }
    else if (k === 'h') setView('heat');
    else if (k === 't') setView('track');
    else if (k === 'p') setView('points');
  });

  window.addEventListener('resize', onResize);
  if (window.ResizeObserver) {
    new ResizeObserver(onResize).observe(el.stageWrap);
  }

  /* ============================================================
     启动
     ============================================================ */
  setEngine('none');
  setRecUI();
  resetQuality('未标定');
  renderContent('article', { silent: true });
  setView('heat');
  updateStats(true);
  requestAnimationFrame(loop);
})();


