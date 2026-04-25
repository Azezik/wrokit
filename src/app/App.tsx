import { routes } from './routes';

function App() {
  return (
    <main style={{ fontFamily: 'Arial, sans-serif', padding: '2rem', lineHeight: 1.5 }}>
      <h1>Wrokit V2 Foundation</h1>
      <p>
        Static browser foundation for a modular human-in-the-loop file ingestion engine.
      </p>
      <p>
        Current route: <code>{routes.home}</code>
      </p>
    </main>
  );
}

export default App;
