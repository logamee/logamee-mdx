import { useAppBootstrap, renderAppWindow } from './features/app/useAppBootstrap';
import './styles.css';

export default function App() {
  return renderAppWindow(useAppBootstrap());
}
