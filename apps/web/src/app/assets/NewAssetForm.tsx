'use client';

import { useCallback, useState } from 'react';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { QueryBoundary } from '../../components/ui/QueryBoundary';
import { useApiQuery } from '../../hooks/useApiQuery';
import { assetsApi } from '../../lib/api/assets';

export function NewAssetForm({ onCreated }: { onCreated: () => void }) {
  const categoriesQuery = useApiQuery(
    useCallback(() => assetsApi.listCategories({ page: 1, limit: 100 }), []),
    [],
  );
  const [name, setName] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await assetsApi.create({ name, categoryId, description: description || undefined });
      setName('');
      setDescription('');
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create asset.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card title="New Asset">
      <QueryBoundary query={categoriesQuery} loadingLabel="Loading categories…">
        {(categories) => (
          <form onSubmit={handleSubmit} className="space-y-3">
            <div>
              <label htmlFor="asset-name" className="block text-sm font-medium text-slate-700">
                Name
              </label>
              <input
                id="asset-name"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
              />
            </div>
            <div>
              <label htmlFor="asset-category" className="block text-sm font-medium text-slate-700">
                Category
              </label>
              <select
                id="asset-category"
                required
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
              >
                <option value="" disabled>
                  Select a category…
                </option>
                {categories.items.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="asset-description" className="block text-sm font-medium text-slate-700">
                Description (optional)
              </label>
              <textarea
                id="asset-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
              />
            </div>
            {error ? <p className="text-sm text-red-600">{error}</p> : null}
            <Button type="submit" disabled={submitting || !categoryId}>
              {submitting ? 'Creating…' : 'Create Asset'}
            </Button>
          </form>
        )}
      </QueryBoundary>
    </Card>
  );
}
