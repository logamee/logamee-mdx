import { LazyMotion, MotionConfig, domAnimation } from 'motion/react';
import { useAppBootstrap, renderAppWindow } from './features/app/useAppBootstrap';
import './styles.css';

export default function App() {
  return (
    <LazyMotion features={domAnimation}>
      <MotionConfig reducedMotion="user">
        {renderAppWindow(useAppBootstrap())}
      </MotionConfig>
    </LazyMotion>
  );
}
