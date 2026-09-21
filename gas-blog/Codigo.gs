const BLOG_DATA_KEY = 'BRUNA_BLOG_ARTICLES_V1';
const BLOG_FIREBASE_API_KEY = 'AIzaSyBF79NzYAj7umrbaVngFBlevLHCWvSf00g';
const BLOG_ALLOWED_EMAILS = [
  'divarebel.on@gmail.com',
  'financeiro.brunaboreggio@gmail.com'
];
const BLOG_CATEGORIES = [
  'emagrecimento', 'receitas', 'compulsao-e-fome',
  'metabolismo-e-hormonios', 'hipertrofia', 'habitos-e-rotina'
];

function doGet(e) {
  try {
    const action = String((e && e.parameter && e.parameter.action) || 'list');
    if (action === 'health') return json_({ ok: true, service: 'bruna-blog', version: 2 });
    if (action === 'adminList') {
      const user = requireAdmin_(e.parameter.token);
      return json_({ ok: true, user: user.email, articles: readArticles_() });
    }
    const articles = readArticles_();
    return json_({
      ok: true,
      managedIds: articles.map(article => article.id),
      articles: articles.filter(article => article.status === 'published')
    });
  } catch (error) {
    return json_({ ok: false, error: String(error.message || error) });
  }
}

function doPost(e) {
  try {
    const data = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const user = requireAdmin_(data.token);
    if (data.action === 'save') {
      const article = normalizeArticle_(data.article, user.email);
      const articles = readArticles_().filter(item => item.id !== article.id);
      articles.push(article);
      writeArticles_(articles);
      return json_({ ok: true, article: article });
    }
    if (data.action === 'delete') {
      const id = String(data.id || '');
      if (!id) throw new Error('Conteúdo não informado.');
      const articles = readArticles_().filter(item => item.id !== id);
      articles.push({ id: id, status: 'deleted', updatedAt: new Date().toISOString(), updatedBy: user.email });
      writeArticles_(articles);
      return json_({ ok: true });
    }
    throw new Error('Ação inválida.');
  } catch (error) {
    return json_({ ok: false, error: String(error.message || error) });
  }
}

function readArticles_() {
  const value = PropertiesService.getScriptProperties().getProperty(BLOG_DATA_KEY);
  if (!value) return [];
  try {
    const articles = JSON.parse(value);
    return Array.isArray(articles) ? articles : [];
  } catch (error) {
    throw new Error('O banco de conteúdos precisa de manutenção.');
  }
}

function writeArticles_(articles) {
  const value = JSON.stringify(articles);
  if (value.length > 450000) throw new Error('O banco do blog atingiu o limite de armazenamento.');
  PropertiesService.getScriptProperties().setProperty(BLOG_DATA_KEY, value);
}

function normalizeArticle_(input, email) {
  if (!input || typeof input !== 'object') throw new Error('Conteúdo inválido.');
  const id = slugify_(input.id || input.title);
  if (!id || !String(input.title || '').trim() || !String(input.body || '').trim()) {
    throw new Error('Título e conteúdo são obrigatórios.');
  }
  if (BLOG_CATEGORIES.indexOf(input.category) < 0) throw new Error('Categoria inválida.');
  const current = readArticles_().find(item => item.id === id);
  const now = new Date().toISOString();
  return {
    id: id,
    category: input.category,
    title: String(input.title).trim().slice(0, 180),
    description: String(input.description || '').trim().slice(0, 165),
    excerpt: String(input.excerpt || '').trim().slice(0, 400),
    body: String(input.body).trim(),
    tags: Array.isArray(input.tags) ? input.tags.map(String).slice(0, 20) : [],
    time: String(input.time || '4 min'),
    colors: Array.isArray(input.colors) ? input.colors.slice(0, 2) : ['#B87B6A', '#E9CFC5'],
    coverImage: /^https:\/\//i.test(String(input.coverImage || '')) ? String(input.coverImage).trim().slice(0, 2000) : '',
    status: input.status === 'draft' ? 'draft' : 'published',
    createdAt: current && current.createdAt ? current.createdAt : now,
    updatedAt: now,
    updatedBy: email
  };
}

function requireAdmin_(idToken) {
  if (!idToken) throw new Error('Faça login para continuar.');
  const response = UrlFetchApp.fetch(
    'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + encodeURIComponent(BLOG_FIREBASE_API_KEY),
    {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ idToken: idToken }),
      muteHttpExceptions: true
    }
  );
  if (response.getResponseCode() !== 200) throw new Error('Sua sessão expirou. Entre novamente.');
  const payload = JSON.parse(response.getContentText());
  const user = payload.users && payload.users[0];
  const email = String(user && user.email || '').toLowerCase();
  if (!user || !user.emailVerified || BLOG_ALLOWED_EMAILS.indexOf(email) < 0) {
    throw new Error('Esta conta não tem autorização para administrar o blog.');
  }
  return { email: email, uid: user.localId };
}

function slugify_(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function json_(value) {
  return ContentService.createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}
