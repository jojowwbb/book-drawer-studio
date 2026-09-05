import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { BookPage } from './pages/BookPage';
import { CreatePage } from './pages/CreatePage';
import { ProjectCreatePage } from './pages/ProjectCreatePage';
import { ProjectPage } from './pages/ProjectPage';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root element');

createRoot(root).render(
  // 不启用 StrictMode：开发模式 effect 双调用会与 PixiJS/WebGL 初始化竞态
  <BrowserRouter>
    <Routes>
      <Route path="/" element={<CreatePage />} />
      <Route path="/book/:id" element={<BookPage />} />
      <Route path="/project/create" element={<ProjectCreatePage />} />
      <Route path="/project/:id" element={<ProjectPage />} />
    </Routes>
  </BrowserRouter>,
);
