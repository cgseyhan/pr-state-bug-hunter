import React, { useState, useEffect } from 'react';

// ----------------------------------------------------
// ⚠️ TEST CASE 1: Direct Async Callback in useEffect
// ----------------------------------------------------
export function BuggyComponentOne() {
  const [user, setUser] = useState(null);

  useEffect(async () => {
    const res = await fetch('/api/user');
    const data = await res.json();
    setUser(data);
  }, []);

  return <div>{user?.name}</div>;
}

// ----------------------------------------------------
// ⚠️ TEST CASE 2: Uncleaned Event Listener inside useEffect
// ----------------------------------------------------
export function BuggyComponentTwo() {
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const handleResize = () => {
      setDimensions({ width: window.innerWidth, height: window.innerHeight });
    };
    window.addEventListener('resize', handleResize);
    // Missing removeEventListener cleanup!
  }, []);

  return <div>{dimensions.width}px</div>;
}

// ----------------------------------------------------
// ⚠️ TEST CASE 3: Uncleaned/Unguarded Async API Call in useEffect (Race Condition)
// ----------------------------------------------------
export function BuggyComponentThree({ resourceId }) {
  const [details, setDetails] = useState(null);

  useEffect(() => {
    fetch(`/api/resources/${resourceId}`)
      .then(res => res.json())
      .then(data => {
        setDetails(data); // State update will fire on unmounted/stale component
      });
    // Missing AbortController or mount flag guard!
  }, [resourceId]);

  return <div>Details: {details?.title}</div>;
}

// ----------------------------------------------------
// ⚠️ TEST CASE 4: Stale Closure in Async Handler
// ----------------------------------------------------
export function BuggyComponentFour() {
  const [count, setCount] = useState(0);

  const incrementAsync = async () => {
    await new Promise(resolve => setTimeout(resolve, 1000));
    setCount(count + 1); // Reads stale "count" closure variable
  };

  return <button onClick={incrementAsync}>Count: {count}</button>;
}

// ----------------------------------------------------
// ⚠️ TEST CASE 5: Unframed TCP/Stream JSON-RPC parser
// ----------------------------------------------------
export function initStreamClient(socket) {
  socket.on('data', (chunk) => {
    // Message boundaries are ignored. Assuming single data packet equals one full JSON string.
    const packet = JSON.parse(chunk.toString());
    console.log('Received frame:', packet);
  });
}

// ----------------------------------------------------
// ✅ GOOD CASES: Verified Correct & Clean implementations
// ----------------------------------------------------
export function CleanComponent({ resourceId }) {
  const [count, setCount] = useState(0);
  const [details, setDetails] = useState(null);

  // Clean useEffect with AbortController for race condition guard
  useEffect(() => {
    const controller = new AbortController();

    const load = async () => {
      try {
        const res = await fetch(`/api/resources/${resourceId}`, { signal: controller.signal });
        const data = await res.json();
        setDetails(data);
      } catch (err) {
        if (err.name !== 'AbortError') {
          console.error(err);
        }
      }
    };

    load();

    return () => {
      controller.abort();
    };
  }, [resourceId]);

  // Clean useEffect with event listener cleanup
  useEffect(() => {
    const handleScroll = () => console.log('scrolled');
    window.addEventListener('scroll', handleScroll);
    return () => {
      window.removeEventListener('scroll', handleScroll);
    };
  }, []);

  // Clean async increment using functional updates
  const safeIncrement = async () => {
    await new Promise(resolve => setTimeout(resolve, 1000));
    setCount(prev => prev + 1); // Safe!
  };

  return <button onClick={safeIncrement}>Clean Count: {count}</button>;
}

// ----------------------------------------------------
// ✅ GOOD CASE: Transitive Cleanup Function Reference (Taint analysis validation)
// ----------------------------------------------------
export function TransitiveCleanComponent() {
  useEffect(() => {
    const handleResize = () => console.log('resized');
    window.addEventListener('resize', handleResize);
    
    const cleanupFn = () => {
      window.removeEventListener('resize', handleResize);
    };
    
    return cleanupFn; // AST parser must resolve this reference and mark it clean!
  }, []);
  
  return <div>Transitive Clean</div>;
}
