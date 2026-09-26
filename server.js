const path = require('path');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// 内置示例：原稿 + 预置人物规则（称呼 / 统一代号）
app.get('/api/example', (req, res) => {
  res.json(require('./example.json'));
});

app.listen(PORT, () => {
  console.log(`访谈稿匿名化映射编辑器已启动: http://localhost:${PORT}`);
});
