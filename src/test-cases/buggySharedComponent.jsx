import React, { useState, useEffect } from 'react';

export function BuggySharedComponent({ userId }) {
  const [profile, setProfile] = useState(null);

  // Unguarded async operation (MEDIUM severity by default)
  useEffect(() => {
    fetch(`/api/users/${userId}`)
      .then(res => res.json())
      .then(data => setProfile(data));
  }, [userId]);

  return <div>Profile: {profile?.name}</div>;
}
